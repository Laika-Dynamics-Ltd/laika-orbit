declare module '@showreel/studio/app.js' {
  export function mount(el: Element, opts?: { apiBase?: string }): { refresh(): Promise<void> }
}
