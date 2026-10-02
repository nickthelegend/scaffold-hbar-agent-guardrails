import { Client, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { IntentPublisher, PublishedIntent } from "./intent";

/** Publishes intents with the agent's own Hedera account, which is the topic's submit key. */
export class HcsIntentPublisher implements IntentPublisher {
  constructor(private readonly client: Client) {}

  async publish(topicId: string, message: string): Promise<PublishedIntent> {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      .execute(this.client);
    const receipt = await response.getReceipt(this.client);
    return {
      topicId,
      sequenceNumber: Number(receipt.topicSequenceNumber ?? 0),
      transactionId: response.transactionId.toString(),
    };
  }
}
