export abstract class BaseSerializer {
  abstract serialize(data: unknown): Uint8Array
  abstract deserialize(data: Uint8Array | ArrayBuffer): unknown
}
