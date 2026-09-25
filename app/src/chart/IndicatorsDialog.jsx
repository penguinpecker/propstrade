import React, { useEffect, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Badge, Button, Dialog, Empty, Field, Notice } from '../ui.jsx';
import { STUDIES, validInput } from './registry.js';
import { MAX_STUDIES } from './storage.js';

/** TradingView's indicator picker: a search and the list; each click adds another instance to the chart, up to MAX_STUDIES. */
export function IndicatorsDialog({ studies, onAdd, onClose }) {
  const [search, setSearch] = useState('');
  const full = studies.length >= MAX_STUDIES;
  const input = useRef(null);
  useEffect(() => { input.current.focus(); }, []); // the dialog focuses its first control (Close) as it opens
  const query = search.trim().toLowerCase();
  const rows = Object.entries(STUDIES).filter(([, d]) => `${d.name} ${d.short} ${d.description}`.toLowerCase().includes(query));
  return <Dialog title="Indicators" className="tv-indicators" onClose={onClose}>
    <div className="search-field"><Search size={16} /><input ref={input} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" aria-label="Search indicators" /></div>
    <div className="tv-indicator-list">
      {rows.map(([type, d]) => {
        const count = studies.filter(s => s.type === type).length;
        return <button key={type} type="button" disabled={full} onClick={() => onAdd(type)}><span><strong>{d.name}</strong><small>{d.description}</small></span>{count > 0 && <Badge tone="purple">{count} on chart</Badge>}<Plus size={15} aria-hidden="true" /></button>;
      })}
      {!rows.length && <Empty title="No matching indicator">Try a name such as RSI or moving average.</Empty>}
    </div>
    {full && <Notice tone="amber">{`The chart holds up to ${MAX_STUDIES} indicators. Remove one to add another.`}</Notice>}
    <Notice>Volume-based indicators (Volume, VWAP, OBV, MFI) are not offered: these candles carry no trading volume.</Notice>
  </Dialog>;
}

/** Inputs and line colours of one instance; Apply keeps them only when every input is in range. */
export function StudySettings({ study, onApply, onClose }) {
  const def = STUDIES[study.type];
  const [inputs, setInputs] = useState(() => Object.fromEntries(Object.entries(study.inputs).map(([k, v]) => [k, String(v)])));
  const [colors, setColors] = useState(study.colors);
  const values = Object.fromEntries(Object.keys(def.inputs).map(k => [k, inputs[k].trim() === '' ? NaN : Number(inputs[k])]));
  const valid = Object.entries(def.inputs).every(([k, spec]) => validInput(spec, values[k]));
  const reset = () => { setInputs(Object.fromEntries(Object.entries(def.inputs).map(([k, spec]) => [k, String(spec.value)]))); setColors(def.lines.map(l => l.color ?? null)); };
  return <Dialog title={`${def.name} settings`} className="tv-settings" onClose={onClose}>
    <div className="tv-settings-grid">
      {Object.entries(def.inputs).map(([k, spec]) => <Field key={k} label={spec.label} hint={`${spec.min} to ${spec.max}`}><input type="number" inputMode="decimal" min={spec.min} max={spec.max} step={spec.step} value={inputs[k]} aria-invalid={!validInput(spec, values[k])} onChange={e => setInputs({ ...inputs, [k]: e.target.value })} /></Field>)}
    </div>
    <div className="tv-color-rows">
      {def.lines.map((line, k) => !line.histogram && <label key={line.name}><span>{line.name}</span><input type="color" value={colors[k]} onChange={e => setColors(colors.map((c, i) => i === k ? e.target.value : c))} /></label>)}
    </div>
    {!valid && <p className="field-error">Each input needs a value within its range{Object.values(def.inputs).some(s => s.step === 1) ? ', in whole numbers' : ''}.</p>}
    <div className="button-row"><Button variant="secondary" onClick={reset}>Defaults</Button><Button disabled={!valid} onClick={() => onApply({ ...study, inputs: values, colors })}>Apply</Button></div>
  </Dialog>;
}
