import React from 'react';

export declare function aiAvailability(): { available: boolean; reason: string; backend: string };
export declare function askAi(prompt: string, instructions?: string): Promise<string | null>;
export declare function askStructured(
  prompt: string,
  instructions?: string
): Promise<{ headline: string; detail: string; backend: string } | null>;
export declare function supportsStructured(): boolean;

export default function AiAssist(props: {
  app?: string;
  hint?: string;
  gutter?: number;
  bottom?: number;
}): React.ReactElement;
