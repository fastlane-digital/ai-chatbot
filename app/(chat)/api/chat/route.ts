import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  // createStreamId, // Removed: No longer using Vercel resumable streams
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  // getStreamIdsByChatId, // Removed: No longer using Vercel resumable streams
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils'; // getTrailingMessageId might be complex with new streaming
import { generateTitleFromUserMessage } from '../../actions';
// Tool imports commented out for now
// import { createDocument } from '@/lib/ai/tools/create-document';
// import { updateDocument } from '@/lib/ai/tools/update-document';
// import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
// import { getWeather } from '@/lib/ai/tools/get-weather';
// import { isProductionEnvironment } from '@/lib/constants'; // May not be needed if telemetry changes
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
// import { geolocation } from '@vercel/functions'; // Removed
// import {
//   createResumableStreamContext, // Removed
//   type ResumableStreamContext,  // Removed
// } from 'resumable-stream';
// import { after } from 'next/server'; // Removed with createResumableStreamContext
import type { Chat, Message as DbMessage } from '@/lib/db/schema'; // Added DbMessage for clarity
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import type { Content } from '@google/generative-ai'; // Import for Gemini history type

export const maxDuration = 60;

// let globalStreamContext: ResumableStreamContext | null = null; // Removed

// function getStreamContext() { // Removed
//   if (!globalStreamContext) {
//     try {
//       globalStreamContext = createResumableStreamContext({
//         waitUntil: after,
//       });
//     } catch (error: any) {
//       if (error.message.includes('REDIS_URL')) {
//         console.log(
//           ' > Resumable streams are disabled due to missing REDIS_URL',
//         );
//       } else {
//         console.error(error);
//       }
//     }
//   }
//   return globalStreamContext;
// }

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const { id, message, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const dbPreviousMessages = await getMessagesByChatId({ id });

    // Transform previousMessages for Gemini
    // Assuming DbMessage has role and parts (which is an array of objects with text)
    // And that message.parts from requestBody is similar or just a simple text string
    // For simplicity, assuming parts is { text: string } or similar
    const history: Content[] = dbPreviousMessages.map((msg: DbMessage) => {
      // Ensure msg.parts is correctly transformed.
      // This is a placeholder and might need adjustment based on actual DbMessage structure.
      // Assuming msg.parts is an array like [{ type: 'text', content: '...' }] or similar from DB
      // Gemini expects parts: [{ text: "string" }]
      let textContent = '';
      if (Array.isArray(msg.parts)) {
        // Attempt to find a text part, or concatenate, or take first. This needs verification.
        const firstTextPart = msg.parts.find(p => typeof (p as any).text === 'string');
        if (firstTextPart) textContent = (firstTextPart as any).text;
        else if (msg.parts.length > 0 && typeof (msg.parts[0] as any).content === 'string') textContent = (msg.parts[0] as any).content;
        else textContent = msg.parts.map(p => (p as any).text || (p as any).content || '').join(' ');
      } else if (typeof msg.parts === 'string') { // Should not happen based on schema usually
        textContent = msg.parts;
      }

      return {
        role: msg.role === 'assistant' ? 'model' : 'user', // Map 'assistant' to 'model'
        parts: [{ text: textContent.trim() }],
      };
    });

    // Current user message also needs to be formatted for sendMessageStream
    // Assuming message.parts is an array of { type: 'text', text: string } or similar
    let currentMessageContent = '';
    if (Array.isArray(message.parts)) {
      const firstTextPart = message.parts.find(p => typeof (p as any).text === 'string');
      if (firstTextPart) currentMessageContent = (firstTextPart as any).text;
      else if (message.parts.length > 0 && typeof (message.parts[0] as any).content === 'string') currentMessageContent = (message.parts[0] as any).content;
      else currentMessageContent = message.parts.map(p => (p as any).text || (p as any).content || '').join(' ');
    } else if (typeof (message.parts as any) === 'string') { // if parts is just a string
      currentMessageContent = message.parts as any;
    } else {
      // Fallback if message.parts structure is unexpected.
      // This might happen if the client sends a different format.
      console.warn("Unexpected message.parts structure:", message.parts);
      currentMessageContent = "Could not parse user message content.";
    }

    let clientIp: string | undefined = undefined;
    const xForwardedFor = request.headers.get('x-forwarded-for');
    if (xForwardedFor) {
      clientIp = xForwardedFor.split(',')[0].trim();
    } else {
      clientIp = request.headers.get('x-real-ip')?.trim();
    }
    // In Next.js Edge runtime, you might also use request.ip if available
    // if ((request as any).ip) {
    //   clientIp = (request as any).ip;
    // }

    // RequestHints type definition (expected in lib/ai/prompts.ts)
    // will likely need to be updated to remove longitude, latitude, city, country
    // and potentially add clientIp: string | undefined.
    const requestHints: RequestHints = {
      // longitude: undefined, // Removed
      // latitude: undefined,  // Removed
      // city: undefined,      // Removed
      // country: undefined,   // Removed
      clientIp: clientIp,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id, // The user's message ID
          role: 'user',
          parts: message.parts, // Keep original parts for DB
          attachments: message.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    });

    // const streamId = generateUUID(); // Removed: No resumable streams
    // await createStreamId({ streamId, chatId: id }); // Removed

    const modelInstance = myProvider.languageModel(selectedChatModel);
    const systemInstruction = systemPrompt({ selectedChatModel, requestHints });

    const chatSession = modelInstance.startChat({
      history,
      systemInstruction: { role: "system", parts: [{text: systemInstruction}]} // Adjust if systemPrompt returns complex object
      // generationConfig: { // Add if needed, e.g., maxOutputTokens, temperature
      //   maxOutputTokens: 1000,
      // },
      // tools: [], // Commented out for now
    });

    const streamResult = await chatSession.sendMessageStream(currentMessageContent); // Pass only the new message content

    let accumulatedText = "";
    const assistantMessageId = generateUUID(); // Generate ID for assistant's response

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for await (const chunk of streamResult.stream) {
          const text = chunk.text();
          accumulatedText += text;
          // Client expects specific JSON objects if using useChat or similar Vercel hooks
          // Sending text delta directly as part of a JSON structure
          // This structure { type: 'text-delta', data: text } is an example.
          // The client needs to be adapted to handle this.
          // Or, if client expects plain text stream: controller.enqueue(encoder.encode(text));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text-delta', content: text })}\n\n`));
        }
        controller.close();

        // After stream is finished, save the accumulated assistant message
        if (session.user?.id) {
          try {
            // Ensure accumulatedText is saved correctly, probably as a single part.
            const assistantParts = [{ type: 'text', text: accumulatedText }]; // Example structure

            await saveMessages({
              messages: [
                {
                  id: assistantMessageId,
                  chatId: id,
                  role: 'assistant', // Gemini uses 'model', but we save 'assistant'
                  parts: assistantParts, // Save the accumulated parts
                  attachments: [], // No attachments from basic text response
                  createdAt: new Date(),
                },
              ],
            });
          } catch (e) {
            console.error('Failed to save assistant message:', e);
          }
        }
      },
      cancel() {
        console.log('Stream cancelled by client.');
      }
    });

    return new Response(readableStream, {
      headers: { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache' },
    });

  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error("Unhandled error in POST:", error);
    return new ChatSDKError('internal_server_error:api').toResponse();
  }
}

export async function GET(request: Request) {
  // const streamContext = getStreamContext(); // Removed
  // const resumeRequestedAt = new Date(); // Removed

  // if (!streamContext) { // Removed
  //   return new Response(null, { status: 204 });
  // }

  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  // Resuming streams with Gemini is not directly supported by this logic.
  // This GET handler's original purpose (resuming Vercel AI SDK streams) is moot.
  // It could be repurposed to fetch chat history, or simply disabled/simplified.
  // For now, returning a 204 No Content or an error, as stream resumption is out of scope.
  console.log("GET /api/chat called, but stream resumption is not supported with Gemini in this setup.");
  return new Response(null, { status: 204, statusText: "Stream resumption not supported with this configuration." });


  // All the following logic related to stream resumption is commented out or removed.
  /*
  let chat: Chat;

  try {
    chat = await getChatById({ id: chatId });
  } catch {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (!chat) {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (chat.visibility === 'private' && chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const streamIds = await getStreamIdsByChatId({ chatId });

  if (!streamIds.length) {
    return new ChatSDKError('not_found:stream').toResponse();
  }

  const recentStreamId = streamIds.at(-1);

  if (!recentStreamId) {
    return new ChatSDKError('not_found:stream').toResponse();
  }

  const emptyDataStream = createDataStream({ // createDataStream is removed
    execute: () => {},
  });

  const stream = await streamContext.resumableStream( // streamContext is removed
    recentStreamId,
    () => emptyDataStream,
  );

  if (!stream) {
    const messages = await getMessagesByChatId({ id: chatId });
    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
      return new Response(emptyDataStream, { status: 200 });
    }

    if (mostRecentMessage.role !== 'assistant') {
      return new Response(emptyDataStream, { status: 200 });
    }

    const messageCreatedAt = new Date(mostRecentMessage.createdAt);

    if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > 15) {
      return new Response(emptyDataStream, { status: 200 });
    }

    const restoredStream = createDataStream({ // createDataStream is removed
      execute: (buffer) => {
        buffer.writeData({
          type: 'append-message',
          message: JSON.stringify(mostRecentMessage),
        });
      },
    });

    return new Response(restoredStream, { status: 200 });
  }

  return new Response(stream, { status: 200 });
  */
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
