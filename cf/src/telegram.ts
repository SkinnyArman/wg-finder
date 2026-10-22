export interface Button { text: string; callback_data: string }

export class Telegram {
  private token: string;
  private chatId: string;
  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      // A topic that was deleted (or a wrong id): post in General rather than lose it.
      if (payload.message_thread_id && /thread not found/i.test(body)) {
        const { message_thread_id: _, ...rest } = payload;
        return this.call(method, rest);
      }
      throw new Error(`Telegram ${method} ${r.status}: ${body}`);
    }
    return r.json();
  }

  send(text: string, opts: Record<string, unknown> = {}, chatId?: string) {
    return this.call("sendMessage", {
      chat_id: chatId ?? this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
  }

  sendPhoto(photo: string, caption: string, chatId?: string, opts: Record<string, unknown> = {}) {
    return this.call("sendPhoto", {
      chat_id: chatId ?? this.chatId, photo, caption, parse_mode: "HTML", ...opts,
    });
  }

  keyboard(rows: Button[][]) {
    return { reply_markup: { inline_keyboard: rows } };
  }

  answerCallback(id: string, text = "", alert = false) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id, text, show_alert: alert,
    });
  }

  editText(chatId: number | string, messageId: number, text: string,
           rows?: Button[][]) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
  }

  clearKeyboard(chatId: number | string, messageId: number) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId,
    });
  }
}

/** Post into a forum topic; nothing when there is none (plain groups, General). */
export const inTopic = (thread?: number | null): Record<string, unknown> =>
  thread ? { message_thread_id: thread } : {};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
