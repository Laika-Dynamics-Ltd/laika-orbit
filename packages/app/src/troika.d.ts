declare module 'troika-three-text' {
  import type { Material, Mesh } from 'three'
  export class Text extends Mesh {
    text: string
    font?: string | undefined
    fontSize: number
    fontWeight: number | string
    color: number | string
    anchorX: number | string
    anchorY: number | string
    outlineWidth: number | string
    outlineColor: number | string
    sdfGlyphSize: number
    letterSpacing: number
    material: Material & { depthTest: boolean; transparent: boolean }
    sync(cb?: () => void): void
    dispose(): void
  }
  export function preloadFont(opts: unknown, cb: () => void): void
}
