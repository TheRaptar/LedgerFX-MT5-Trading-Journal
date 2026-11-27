/** Tiny framework-neutral request/response surface so the same routes run on Express (Node) and Workers. */
export interface ReqLike {
  params: Record<string, string>;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  path: string;
  ip?: string;
  protocol: string;
  get(name: string): string | undefined;
}

export interface ResLike {
  status(code: number): ResLike;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export type NextLike = () => void;
export type HandlerLike = (req: ReqLike, res: ResLike, next: NextLike) => void | Promise<void>;

export interface AppLike {
  get(path: string, ...handlers: HandlerLike[]): unknown;
  post(path: string, ...handlers: HandlerLike[]): unknown;
  put(path: string, ...handlers: HandlerLike[]): unknown;
  patch(path: string, ...handlers: HandlerLike[]): unknown;
  delete(path: string, ...handlers: HandlerLike[]): unknown;
}
