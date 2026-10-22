import vm from "node:vm";
import { BOARD_HTML } from "../../src/core/hub/board.js";
import { BOARD_CORE_SCRIPT } from "../../src/core/hub/board-client.js";
interface FocusState { active: Element | null; body: Element | null; }
export class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  textContent = ""; className = ""; hidden = false; disabled = false; id = ""; tabIndex = 0; href = ""; type = ""; value = "";
  dataset: Record<string,string> = {}; attrs: Record<string,string> = {};
  listeners: Record<string, ((event: any) => void)[]> = {};
  focused = false; open = false;
  // Scroll model mirroring native semantics (CSSOM View): scrollTop writes on
  // a disconnected node have no layout box and no effect; writes clamp to the
  // scroll range. Heights default to a layout box for mounted .log-lines
  // windows (line ≈ 24px, viewport 228px = the CSS max-height); tests can
  // override either height explicitly.
  private _scrollTop = 0; private _scrollHeight: number | null = null; private _clientHeight: number | null = null;
  get scrollTop() { return this._scrollTop; }
  set scrollTop(v) { if (!this.isConnected) return; this._scrollTop = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); }
  get scrollHeight() { return this._scrollHeight ?? (this.isConnected && this.className.includes("log-lines") ? this.children.length * 24 : 0); }
  set scrollHeight(v) { this._scrollHeight = v; }
  get clientHeight() { return this._clientHeight ?? (this.isConnected && this.className.includes("log-lines") ? 228 : 0); }
  set clientHeight(v) { this._clientHeight = v; }
  constructor(readonly tagName: string, private readonly focusState?: FocusState) {}
  get isConnected(): boolean { return !!this.focusState?.body?.contains(this); }
  contains(target: Element | null): boolean { return target === this || this.children.some(c => c.contains(target)); }
  append(...children: Element[]) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.textContent = ""; this.append(...children);
    const active = this.focusState?.active;
    if (active && !active.isConnected) { active.focused = false; this.focusState!.active = this.focusState!.body; }
  }
  setAttribute(key: string,value: string) {
    this.attrs[key]=value;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())] = value;
  }
  addEventListener(key: string,fn: (e: any) => void) { (this.listeners[key] ??= []).push(fn); }
  dispatch(key: string, extra: Record<string,unknown> = {}) { for(const fn of this.listeners[key] ?? []) fn({preventDefault(){},...extra}); }
  focus(_options?: unknown) {
    if (!this.isConnected) throw new Error('Attempted to focus a detached node');
    if (this.disabled) return;
    if (this.focusState!.active) this.focusState!.active.focused = false;
    this.focusState!.active = this; this.focused = true;
  }
  querySelectorAll(selector: string): Element[] {
    const match = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!match) return this.all().slice(1).filter(e=>e.tagName===selector);
    const key=match[1]!.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase());
    return this.all().slice(1).filter(e=>Object.hasOwn(e.dataset,key)&&(match[2]===undefined||e.dataset[key]===match[2]));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  scrollIntoView(_options:unknown) {}
  text(): string { return this.textContent+this.children.map(c=>c.text()).join("\n"); }
  all(): Element[] { return [this,...this.children.flatMap(c=>c.all())]; }
}
export function boardV2App(fetcher: any, hash = "") {
  return makeApp(fetcher, hash, BOARD_HTML.match(/<script>([\s\S]*)<\/script>/)![1]!);
}
function makeApp(fetcher: any, hash: string, script: string) {
  const elements = new Map<string,Element>(), focusState: FocusState = {active:null,body:null};
  const body = new Element('body',focusState); focusState.body=body; focusState.active=body;
  const all = () => body.all();
  for(const id of ['workspace-tabs','hub-root','root-warning','tasks-list','runs-list','tasks-connection','runs-connection','tasks-stale','runs-stale','replay-panel','live-meta','state-rail','rows','mid-title','th-activity','th-who','task-diagnostics','panel-warning','r-cap','r-view','r-empty']) {
    const element=new Element('div',focusState); element.id=id; elements.set(id,element); body.append(element);
  }
  const document = {
    body, get activeElement() { return focusState.active; },
    getElementById(id: string) { return elements.get(id) ?? all().find(e=>e.id===id) ?? null; },
    createElement:(tag:string)=>new Element(tag,focusState),createElementNS:(_ns:string,tag:string)=>new Element(tag,focusState),
    querySelectorAll:(selector:string)=>body.querySelectorAll(selector)
  };
  const window = new Element('window'),location={hash,href:''};
  const context = vm.createContext({document,location,window,setTimeout,clearTimeout,Date,URL,AbortController,TextDecoder,Uint8Array,atob,fetch:fetcher});
  vm.runInContext(script, context);
  return { context,elements,document,window,location,all, evaluate:(code:string)=>vm.runInContext(code,context), navigate(next:string){location.hash=next;window.dispatch('hashchange');},stop(){window.dispatch('pagehide');} };
}
export const ok = (data:unknown) => ({ok:true,json:async()=>data});
