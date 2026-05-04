export abstract class BaseSchema {
  abstract dispatch(requestObj: unknown): Promise<unknown>
}
