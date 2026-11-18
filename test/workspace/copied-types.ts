// eslint-disable-next-line @typescript-eslint/no-namespace -- Exercise qualified enum names in editor hovers.
export namespace Media {
  export enum Role {
    Audio = "audio",
    Video = "video",
    Image = "image",
  }
}

interface Library<T> {
  selected: Media.Role.Audio | Media.Role.Video;
  entries: Map<string, T>;
  key: Uppercase<string>;
}

export type LibraryPreview = Library<number>;
