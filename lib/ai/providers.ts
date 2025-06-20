import { GoogleGenerativeAI } from '@google/generative-ai';
// import { isTestEnvironment } from '../constants';
// import {
//   artifactModel,
//   chatModel,
//   reasoningModel,
//   titleModel,
// } from './models.test';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const myProvider = {
  languageModel: (modelId: string) => {
    switch (modelId) {
      case 'chat-model':
      case 'chat-model-reasoning':
      case 'title-model':
      case 'artifact-model':
        return genAI.getGenerativeModel({ model: "gemini-pro" });
      default:
        // Fallback or error for unknown modelId
        console.warn(`Unknown modelId: ${modelId}, falling back to gemini-pro`);
        return genAI.getGenerativeModel({ model: "gemini-pro" });
    }
  },
  // imageModels are not currently supported with the Gemini provider in this setup
  // If needed, this part would require a different approach.
};
