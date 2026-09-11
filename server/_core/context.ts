export interface TrpcContext {
  user: { id: number; role: "editor" | "viewer" } | null;
}

export async function createContext(): Promise<TrpcContext> {
  return { user: null };
}
