/**
 * Shared dependencies for the read tools. One PriorityClient (shared rate
 * limiter + GET cache) and one MetadataStore built on it. Tool functions
 * take this context so unit tests inject mocked fetch and a stubbed
 * MetadataStore; the server wires the real instances in server.ts.
 */
import type { PriorityClient } from "../priority/client.js";
import type { MetadataStore } from "../priority/metadata.js";

export interface ReadToolContext {
  client: PriorityClient;
  meta: MetadataStore;
}
