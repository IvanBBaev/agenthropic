/**
 * WP-A1 - in-memory `AlertSinkPort` for the rules-engine and delivery-loop
 * tests. Records every notification it is handed and answers with a scripted
 * outcome sequence (the last outcome repeats), so a test can drive the retry
 * state machine without a network.
 */
import type { AlertSinkPort, DeliveryOutcome } from '../ports/alert-sink';
import type { AlertNotification } from '../schemas/alerts';

export class InMemoryAlertSink implements AlertSinkPort {
  readonly kind = 'telegram' as const;
  private readonly received: AlertNotification[] = [];
  private readonly outcomes: readonly DeliveryOutcome[];

  constructor(
    readonly targetId: string,
    outcomes: readonly DeliveryOutcome[] = [{ kind: 'sent' }],
  ) {
    if (outcomes.length === 0) throw new Error('InMemoryAlertSink needs at least one outcome');
    this.outcomes = outcomes;
  }

  send(notification: AlertNotification): Promise<DeliveryOutcome> {
    const index = Math.min(this.received.length, this.outcomes.length - 1);
    this.received.push(notification);
    return Promise.resolve(this.outcomes[index] as DeliveryOutcome);
  }

  /** Every notification handed to `send`, in call order (a snapshot). */
  sent(): readonly AlertNotification[] {
    return [...this.received];
  }
}
