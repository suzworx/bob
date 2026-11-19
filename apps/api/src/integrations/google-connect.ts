interface GmailSmokeMessage {
  id: string;
  subject: string | null;
}

interface GmailSmokeResult {
  email: string;
  messages: GmailSmokeMessage[];
}

export interface GmailClient {
  smoke(token: string, maxResults: number): Promise<GmailSmokeResult>;
}

function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string | null {
  const found = headers.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

export function createGmailClient(fetchImpl: typeof fetch = fetch): GmailClient {
  return {
    async smoke(token: string, maxResults: number): Promise<GmailSmokeResult> {
      const profileResponse = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!profileResponse.ok) throw new Error('gmail_profile_failed');
      const profile = await profileResponse.json() as { emailAddress?: unknown };
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.length === 0) {
        throw new Error('gmail_profile_invalid');
      }
      const listResponse = await fetchImpl(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.max(1, Math.min(10, maxResults))}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!listResponse.ok) throw new Error('gmail_list_failed');
      const listed = await listResponse.json() as { messages?: Array<{ id?: unknown }> };
      const ids = (listed.messages ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
      const messages: GmailSmokeMessage[] = [];
      for (const id of ids.slice(0, Math.max(1, Math.min(10, maxResults)))) {
        const messageResponse = await fetchImpl(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!messageResponse.ok) throw new Error('gmail_message_failed');
        const message = await messageResponse.json() as { payload?: { headers?: Array<{ name?: string; value?: string }> } };
        messages.push({ id, subject: headerValue(message.payload?.headers ?? [], 'Subject') });
      }
      return { email: profile.emailAddress, messages };
    },
  };
}
