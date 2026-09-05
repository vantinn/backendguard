import { Injectable } from "@nestjs/common";

@Injectable()
export class NotificationsService {
  // INSECURE for a replicated deployment: in-process state other replicas can't see.
  private readonly pendingNotifications = new Map<string, string[]>();

  // INSECURE: one outbound HTTP request per recipient, serialised.
  async broadcast(recipients: string[], message: string) {
    for (const recipient of recipients) {
      await fetch(`https://push.example.com/send`, {
        method: "POST",
        body: JSON.stringify({ recipient, message })
      });
    }
  }

  queue(userId: string, message: string) {
    const existing = this.pendingNotifications.get(userId) || [];
    this.pendingNotifications.set(userId, [...existing, message]);
  }
}
