import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, LoaderCircle, Upload, X } from 'lucide-react';
import { ApiError, errorMessage, safeUrl } from './api';
import { readMaterials } from './materials';
import type { MaterialInput } from '../shared/types';

export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-mark">◎</div><h3>{title}</h3><p>{text}</p>{children}</div>;
}
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{tone === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<div>{children}</div></div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Modal({ title, description, children, onClose, wide }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const heading = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1} ref={panel}><div className="modal-head"><div><h2 id={heading}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}
export function Busy({ children = '处理中' }: { children?: ReactNode }) { return <span className="inline"><LoaderCircle size={15} className="spin" />{children}</span>; }
export function Score({ value, maximum, label }: { value: number | null; maximum: number; label?: string }) {
  return <span title={label} className={`score score-${maximum === 5 && value && value >= 4 ? 'strong' : value ? 'normal' : 'empty'}`}>{value ? `${value} / ${maximum}` : '待评估'}</span>;
}
export function UploadMaterials({ materials, onChange, disabled = false }: { materials: MaterialInput[]; onChange: (value: MaterialInput[]) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const input = useRef<HTMLInputElement>(null);
  async function receive(files: File[]) { setBusy(true); setError(''); try { onChange([...materials, ...await readMaterials(files)]); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; } }
  return <div><div className={`upload ${disabled ? 'disabled' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!disabled && !busy) void receive(Array.from(event.dataTransfer.files)); }}><Upload size={23} /><strong>拖入资料，或<button className="text-button" type="button" onClick={() => input.current?.click()} disabled={disabled || busy}>选择文件</button></strong><span>{busy ? '正在读取文件…' : 'MD · TXT · CSV · XLSX · DOCX · PDF · JPG · PNG'}</span><small>单个文件最大 6 MB；扫描 PDF 请补充关键页图片</small><input ref={input} type="file" multiple hidden accept=".md,.txt,.csv,.tsv,.json,.xlsx,.xls,.docx,.pdf,.jpg,.jpeg,.png,.webp" onChange={event => void receive(Array.from(event.target.files || []))} /></div>{error && <Notice tone="error">{error}</Notice>}<div className="file-list">{materials.map((material, index) => <div className="file-item" key={`${material.filename}-${index}`}><div><strong>{material.filename}</strong><small>{material.data_url ? '图片 · 交由模型识别' : `${(material.text?.length || 0).toLocaleString()} 字符`}</small>{material.warnings?.map((warning, number) => <small className="warning-text" key={number}>{warning}</small>)}</div><button className="icon-button" disabled={disabled} type="button" aria-label={`移除 ${material.filename}`} onClick={() => onChange(materials.filter((_, at) => at !== index))}><X size={15} /></button></div>)}</div></div>;
}

function inlineMarkdown(text: string): ReactNode[] {
  const pieces = text.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g);
  return pieces.map((piece, index) => {
    const link = piece.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={index} href={safeUrl(link[2])} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={index}>{piece.slice(1, -1)}</code>;
    return piece;
  });
}
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n'); const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) { const code: string[] = []; index++; while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]); blocks.push(<pre key={index}>{code.join('\n')}</pre>); continue; }
    if (/^\s*\|/.test(line)) { const rows: string[][] = []; while (index < lines.length && /^\s*\|/.test(lines[index])) { const row = lines[index].trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim()); if (!row.every(value => /^:?-+:?$/.test(value))) rows.push(row); index++; } index--; blocks.push(<div className="table-scroll" key={index}><table><tbody>{rows.map((row, at) => <tr key={at}>{row.map((value, cell) => at === 0 ? <th key={cell}>{inlineMarkdown(value)}</th> : <td key={cell}>{inlineMarkdown(value)}</td>)}</tr>)}</tbody></table></div>); continue; }
    if (!line.trim()) continue;
    if (/^#{1,6}\s/.test(line)) { const level = line.match(/^#+/)![0].length; blocks.push(level < 3 ? <h3 key={index}>{inlineMarkdown(line.replace(/^#+\s/, ''))}</h3> : <h4 key={index}>{inlineMarkdown(line.replace(/^#+\s/, ''))}</h4>); }
    else if (/^>\s?/.test(line)) blocks.push(<blockquote key={index}>{inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>);
    else if (/^[-*]\s/.test(line)) blocks.push(<div key={index} className="markdown-bullet">• <span>{inlineMarkdown(line.replace(/^[-*]\s/, ''))}</span></div>);
    else if (/^---+$/.test(line)) blocks.push(<hr key={index} />);
    else blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}

export function useVersionedDraft<T extends { id: string; version: number }>(record: T, save: (draft: T, version: number, original: T) => Promise<T>, onSaved: (value: T) => void, enabled = true) {
  const [draft, setDraft] = useState(record); const [base, setBase] = useState(record);
  const [state, setState] = useState<'saved' | 'pending' | 'saving' | 'error' | 'conflict'>('saved'); const [error, setError] = useState('');
  const draftRef = useRef(draft); draftRef.current = draft;
  const saving = useRef(false); const alive = useRef(true);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (record.version !== base.version && !dirty && !saving.current) { setBase(record); setDraft(record); setState('saved'); }
  }, [record, base.version, dirty]);
  async function persist() {
    if (!enabled || saving.current || !dirty || state === 'conflict') return;
    const snapshot = draftRef.current; saving.current = true; setState('saving'); setError('');
    try {
      const saved = await save(snapshot, base.version, base);
      if (!alive.current) return;
      const unchanged = JSON.stringify(draftRef.current) === JSON.stringify(snapshot);
      setBase(saved); setDraft(unchanged ? saved : { ...draftRef.current, version: saved.version });
      setState(unchanged ? 'saved' : 'pending'); onSaved(saved);
    } catch (exception) {
      if (alive.current) { setState(exception instanceof ApiError && exception.status === 409 ? 'conflict' : 'error'); setError(errorMessage(exception)); }
    } finally { saving.current = false; }
  }
  useEffect(() => {
    if (!dirty || !enabled || state === 'conflict' || state === 'error' || state === 'saving') return;
    const timer = setTimeout(() => void persist(), 1200); return () => clearTimeout(timer);
  }, [draft, dirty, state, enabled]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  function update<K extends keyof T>(key: K, value: T[K]) { setDraft(current => ({ ...current, [key]: value })); if (state !== 'conflict') setState('pending'); }
  function reload(latest: T) { setDraft(latest); setBase(latest); setState('saved'); setError(''); }
  return { draft, update, dirty, state, error, persist, reload };
}
export function SaveState({ state }: { state: string }) {
  return <span className={`save-state ${state}`}>{state === 'saving' ? <Busy>保存中</Busy> : state === 'saved' ? <><Check size={14} />已保存</> : state === 'pending' ? '有未保存修改' : state === 'conflict' ? '版本冲突 · 草稿已保留' : '保存失败 · 草稿已保留'}</span>;
}
