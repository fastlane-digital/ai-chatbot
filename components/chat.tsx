'use client';

import type { Attachment, UIMessagePart, UIMessage } from 'ai'; // UIMessagePart might be needed for constructing messages
import { useEffect, useState, useRef, FormEvent } from 'react'; // Added FormEvent, useRef
import useSWR, { useSWRConfig } from 'swr';
import { ChatHeader } from '@/components/chat-header';
import type { Vote } from '@/lib/db/schema';
import { fetcher, fetchWithErrorHandlers, generateUUID } from '@/lib/utils';
import { Artifact } from './artifact';
import { MultimodalInput } from './multimodal-input';
import { Messages } from './messages';
import type { VisibilityType } from './visibility-selector';
import { useArtifactSelector } from '@/hooks/use-artifact';
import { unstable_serialize } from 'swr/infinite';
import { getChatHistoryPaginationKey } from './sidebar-history';
import { toast } from './toast';
import type { Session } from 'next-auth';
import { useSearchParams } from 'next/navigation';
import { useChatVisibility } from '@/hooks/use-chat-visibility';
// import { useAutoResume } from '@/hooks/use-auto-resume'; // Commented out
import { ChatSDKError } from '@/lib/errors';
import type { DataStreamDelta } from './data-stream-handler'; // Assuming DataStreamHandler exports this type

export type ChatStatus = 'idle' | 'loading' | 'error';

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  initialVisibilityType,
  isReadonly,
  session,
  autoResume, // This prop will be unused for now
}: {
  id: string;
  initialMessages: Array<UIMessage>;
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  isReadonly: boolean;
  session: Session;
  autoResume: boolean;
}) {
  const { mutate } = useSWRConfig();
  const { visibilityType } = useChatVisibility({
    chatId: id,
    initialVisibilityType,
  });

  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [streamData, setStreamData] = useState<DataStreamDelta[] | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleUserMessageSubmit = async (
    messageContent: string,
    messageAttachments?: Attachment[],
  ) => {
    if (!messageContent.trim() && (!messageAttachments || messageAttachments.length === 0)) {
      return;
    }

    const userMessageId = generateUUID();
    // Ensure parts is correctly typed. Assuming UIMessagePart or similar.
    // For simplicity, assuming text content for now. Attachments need careful handling.
    const userMessageParts: UIMessagePart[] = [{ type: 'text', text: messageContent }];
    if (messageAttachments) {
      // TODO: Map messageAttachments to UIMessagePart[] correctly
      // This might involve types like 'image', 'file', etc.
      // For now, this is a placeholder.
      console.warn("Attachments are not fully handled in this refactor yet for UIMessage parts.");
    }

    const newUserMessage: UIMessage = {
      id: userMessageId,
      role: 'user',
      parts: userMessageParts,
      // attachments: messageAttachments, // This was from Vercel SDK, parts should now contain attachments
      createdAt: new Date(),
    };

    setMessages((prevMessages) => [...prevMessages, newUserMessage]);
    setInput(''); // Clear input after preparing the message
    setStatus('loading');
    setStreamData([]); // Clear previous stream data

    abortControllerRef.current = new AbortController();

    try {
      const requestBody = {
        id, // chat id
        message: newUserMessage, // The user message object
        selectedChatModel: initialChatModel,
        selectedVisibilityType: visibilityType,
      };

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok || !response.body) {
        const errorJson = await response.json().catch(() => ({ message: response.statusText }));
        throw new ChatSDKError(errorJson.code || 'network_error', errorJson.message);
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let accumulatedDeltas: DataStreamDelta[] = [];
      // The assistant message isn't fully formed yet, so we can't add it to `messages` state here.
      // `streamData` will be used by DataStreamHandler to render the incoming message.
      // Once the stream is complete, we'll need to construct the final assistant message and add it to `messages`.

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const lines = value.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring('data: '.length);
            try {
              const delta = JSON.parse(jsonStr) as DataStreamDelta;
              accumulatedDeltas = [...accumulatedDeltas, delta];
              setStreamData([...accumulatedDeltas]); // Update streamData for DataStreamHandler
            } catch (e) {
              console.error('Failed to parse stream delta:', jsonStr, e);
            }
          }
        }
      }
      // After stream is complete, create the full assistant message from streamData
      // This part is complex because streamData is a series of deltas.
      // We need a robust way to convert streamData (especially text parts) into a UIMessage.
      // For now, the DataStreamHandler is expected to render this.
      // To update the main `messages` list, we'd need to aggregate `streamData` here.
      // This is a simplification: assuming DataStreamHandler handles the final display.
      // A more complete solution would aggregate text from 'text-delta' in streamData
      // and form a new assistant UIMessage, then add it to the messages array.

      mutate(unstable_serialize(getChatHistoryPaginationKey)); // SWR cache mutation
      setStatus('idle');
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Fetch aborted');
        setStatus('idle'); // Or 'cancelled' if you add such a state
        // Create a placeholder assistant message indicating cancellation
        const assistantId = generateUUID();
        const cancelledMessage: UIMessage = {
          id: assistantId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Request cancelled.' }],
          createdAt: new Date(),
        };
        setMessages(prev => [...prev, cancelledMessage]);

      } else {
        setStatus('error');
        const errorMessage = error instanceof ChatSDKError ? error.message : 'An unexpected error occurred.';
        toast({ type: 'error', description: errorMessage });
        // Potentially add an error message to the chat UI
         const assistantId = generateUUID();
         const errorMessageUIMessage: UIMessage = {
          id: assistantId,
          role: 'assistant',
          parts: [{ type: 'text', text: `Error: ${errorMessage}` }],
          createdAt: new Date(),
        };
        setMessages(prev => [...prev, errorMessageUIMessage]);
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>, messageAttachments?: Attachment[]) => {
    e.preventDefault();
    handleUserMessageSubmit(input, messageAttachments);
  };

  const append = async (
    message: Pick<UIMessage, 'role' | 'parts' | 'attachments'>, // content becomes parts
    options?: { autoSubmit?: boolean }
  ) => {
    const messageId = generateUUID();
    // Assuming message.parts is already correctly formatted as UIMessagePart[]
    const contentText = (message.parts.find(p => p.type === 'text') as any)?.text || '';

    const newMessage: UIMessage = {
      id: messageId,
      role: message.role,
      parts: message.parts,
      // attachments: message.attachments, // attachments should be part of 'parts' now
      createdAt: new Date(),
    };
    setMessages((prevMessages) => [...prevMessages, newMessage]);
    if (options?.autoSubmit) {
      // Need to get content from message.parts for auto-submission
      await handleUserMessageSubmit(contentText /*, message.attachments */);
    }
  };

  const stop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setStatus('idle'); // Or a 'cancelled' state
      // The fetch catch block will handle adding a "Request cancelled" message.
    }
  };

  const reload = () => {
    // Placeholder for now. This is complex.
    // It might involve re-sending the last user message or a specific message.
    console.warn('Reload function is not implemented yet.');
    // const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    // if (lastUserMessage) {
    //   // Need to decide how to handle re-submission.
    // }
  };


  const searchParams = useSearchParams();
  const query = searchParams.get('query');
  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    if (query && !hasAppendedQuery && !isReadonly) {
      append(
        { role: 'user', parts: [{ type: 'text', text: query }] },
        { autoSubmit: true }
      );
      setHasAppendedQuery(true);
      window.history.replaceState({}, '', `/chat/${id}`);
    }
  }, [query, append, hasAppendedQuery, id, isReadonly]); // append was from useChat, now local

  const { data: votes } = useSWR<Array<Vote>>(
    messages.length >= 2 ? `/api/vote?chatId=${id}` : null,
    fetcher,
  );

  const [attachments, setAttachments] = useState<Array<Attachment>>([]); // This state seems to be for the input, keep it.
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  // useAutoResume({ // Commented out as experimental_resume and useChat's data are gone
  //   autoResume,
  //   initialMessages,
  //   experimental_resume: () => {}, // Placeholder
  //   data: streamData, // Pass new streamData if needed by a revised useAutoResume
  //   setMessages,
  // });

  return (
    <>
      <div className="flex flex-col min-w-0 h-dvh bg-background">
        <ChatHeader
          chatId={id}
          selectedModelId={initialChatModel}
          selectedVisibilityType={initialVisibilityType}
          isReadonly={isReadonly}
          session={session}
        />

        <Messages
          chatId={id}
          status={status} // Pass new status
          votes={votes}
          messages={messages} // Pass new messages
          setMessages={setMessages} // Pass new setMessages
          reload={reload} // Pass new reload
          isReadonly={isReadonly}
          isArtifactVisible={isArtifactVisible}
        />

        <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl" onSubmit={handleSubmit}>
          {!isReadonly && (
            <MultimodalInput
              chatId={id}
              input={input} // Pass new input
              setInput={setInput} // Pass new setInput
              handleSubmit={handleSubmit} // Pass new handleSubmit
              status={status} // Pass new status
              stop={stop} // Pass new stop
              attachments={attachments}
              setAttachments={setAttachments}
              messages={messages} // Pass new messages
              setMessages={setMessages} // Pass new setMessages
              append={append} // Pass new append
              selectedVisibilityType={visibilityType}
            />
          )}
        </form>
      </div>

      <Artifact
        chatId={id}
        input={input} // Pass new input
        setInput={setInput} // Pass new setInput
        handleSubmit={handleSubmit} // Pass new handleSubmit (consider if Artifact needs its own submission logic)
        status={status} // Pass new status
        stop={stop} // Pass new stop
        attachments={attachments} // Pass new attachments
        setAttachments={setAttachments} // Pass new setAttachments
        append={append} // Pass new append
        messages={messages} // Pass new messages
        setMessages={setMessages} // Pass new setMessages
        reload={reload} // Pass new reload
        votes={votes}
        isReadonly={isReadonly}
        selectedVisibilityType={visibilityType}
        dataStream={streamData} // Pass streamData as 'data' prop
      />
    </>
  );
}
