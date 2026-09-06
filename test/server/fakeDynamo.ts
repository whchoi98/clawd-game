/**
 * Recording stand-in for DynamoDBDocumentClient: every command is captured and
 * answered from a queue — nothing reaches AWS. Queue an Error to make that call
 * reject (e.g. a TransactionCanceledException).
 */
export class FakeClient {
  sent: { name: string; input: Record<string, unknown> }[] = [];
  responses: unknown[] = [];

  async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    const next = this.responses.length ? this.responses.shift() : {};
    if (next instanceof Error) throw next;
    return next;
  }
}
