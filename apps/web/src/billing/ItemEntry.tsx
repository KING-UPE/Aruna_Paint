import {
  D,
  formatMoney,
  formatQty,
  needsPricePopup,
  parseQtyInput,
  type ParsedQty,
} from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { api, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { BillingItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { BatchPicker } from './BatchPicker';
import { litersOnBill, newKey, priceBillLine, splitIntoBatchLines, type BillLine } from './bill';

export interface ItemEntryHandle {
  focus: () => void;
}

export type EmptyKey = 'ArrowUp' | 'ArrowDown' | 'Delete' | '+' | '-';

interface Props {
  wholesale: boolean;
  existing: BillLine[];
  onAdd: (lines: BillLine[]) => void;
  /** Keys typed while the item field is empty act on the selected line. */
  onEmptyKey: (key: EmptyKey) => void;
  /** A can must go into mix paint first; resolves with the refreshed item, or null. */
  onOpenCan: (item: BillingItem, litersNeeded: string) => Promise<BillingItem | null>;
  /** A changed mix paint price needs an Admin PIN. */
  onPriceApproval: () => Promise<boolean>;
  onMoveFromStore: (item: BillingItem) => void;
  canMoveStock: boolean;
}

type Step = 'item' | 'qty' | 'discount' | 'price';

/**
 * The entry row. Typing a code or a name in either field opens the same suggestion list
 * (codes from the first character, names from the second); picking an item fills the row with
 * its code, description, price and default discount, ready for the qty.
 */
export const ItemEntry = forwardRef<ItemEntryHandle, Props>(function ItemEntry(props, ref) {
  const qc = useQueryClient();
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const [codeText, setCodeText] = useState('');
  const [nameText, setNameText] = useState('');
  const [field, setField] = useState<'code' | 'name'>('code');
  const [hi, setHi] = useState(0);
  const [item, setItem] = useState<BillingItem | null>(null);
  const [startBatch, setStartBatch] = useState<string | null>(null);
  const [picker, setPicker] = useState<BillingItem | null>(null);
  const [step, setStep] = useState<Step>('item');
  const [qtyText, setQtyText] = useState('');
  const [discText, setDiscText] = useState('');
  const [defaultDisc, setDefaultDisc] = useState('');
  const [loose, setLoose] = useState<Extract<ParsedQty, { kind: 'LOOSE' }> | null>(null);
  const [unitsQty, setUnitsQty] = useState('1.000');
  const [priceText, setPriceText] = useState('');
  const [error, setError] = useState('');

  useImperativeHandle(ref, () => ({ focus: () => focusStep(step) }));

  const query = field === 'code' ? codeText.trim() : nameText.trim();
  const debounced = useDebounced(query, 120);
  const minLen = field === 'code' ? 1 : 2;
  const searching = !item && debounced.length >= minLen;
  const suggestions = useQuery({
    queryKey: ['billing-items', debounced],
    queryFn: () => api.get<{ items: BillingItem[] }>(`/api/billing/items${qs({ q: debounced })}`),
    enabled: searching,
    staleTime: 5_000,
  });
  // Only suggestions for exactly what is typed now; while the search catches up, Enter fetches
  // fresh results, so a fast typist never gets the previous item.
  const list = searching && debounced === query ? (suggestions.data?.items ?? []) : [];
  const listOpen = !item && query.length >= minLen && list.length > 0;

  // Focus moves right after React commits, before the next key arrives.
  const [focusReq, setFocusReq] = useState<{ step: Step; n: number }>({ step: 'item', n: 0 });
  function focusStep(s: Step) {
    setFocusReq((f) => ({ step: s, n: f.n + 1 }));
  }
  useLayoutEffect(() => {
    if (focusReq.n === 0) return;
    const s = focusReq.step;
    const el =
      s === 'qty'
        ? qtyRef.current
        : s === 'discount'
          ? discRef.current
          : s === 'price'
            ? priceRef.current
            : codeRef.current;
    el?.focus();
    el?.select();
  }, [focusReq]);

  function reset() {
    setCodeText('');
    setNameText('');
    setItem(null);
    setStartBatch(null);
    setQtyText('');
    setDiscText('');
    setDefaultDisc('');
    setLoose(null);
    setPriceText('');
    setError('');
    setHi(0);
    setStep('item');
    setField('code');
    focusStep('item');
  }

  function choose(it: BillingItem) {
    setItem(it);
    setCodeText(it.code);
    setNameText(it.name);
    setError('');
    const matched =
      it.matchedSubProductId && it.batches.some((b) => b.id === it.matchedSubProductId)
        ? it.matchedSubProductId
        : null;
    if (!matched && needsPricePopup(it.batches, props.wholesale)) {
      setPicker(it);
      return;
    }
    goQty(it, matched ?? it.batches[0]?.id ?? null);
  }

  function goQty(it: BillingItem, batchId: string | null) {
    setStartBatch(batchId);
    const b = it.batches.find((x) => x.id === batchId);
    const d =
      b && !props.wholesale && D(b.rPrice).greaterThan(0) && D(b.salesDiscount).greaterThan(0)
        ? `${D(b.salesDiscount).dividedBy(D(b.rPrice)).times(100).toDecimalPlaces(2).toString()}%`
        : '0%';
    setDefaultDisc(d);
    setDiscText(d);
    if (!it.batches.length && !it.allowLooseSale) {
      setError(
        D(it.stockElsewhere).greaterThan(0)
          ? `None here. ${formatQty(it.stockElsewhere)} in other locations.`
          : 'Out of stock here.',
      );
    }
    setStep('qty');
    focusStep('qty');
  }

  async function pickHighlighted() {
    let items = list;
    if (!items.length && query.length >= 1) {
      const r = await qc.fetchQuery({
        queryKey: ['billing-items', query],
        queryFn: () => api.get<{ items: BillingItem[] }>(`/api/billing/items${qs({ q: query })}`),
      });
      items = r.items;
    }
    const it = items[Math.min(hi, items.length - 1)];
    if (it) choose(it);
    else setError('No item matches. Check the code or name.');
  }

  function onItemKey(e: KeyboardEvent<HTMLInputElement>) {
    const text = field === 'code' ? codeText : nameText;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (listOpen)
        setHi((h) =>
          e.key === 'ArrowDown' ? Math.min(list.length - 1, h + 1) : Math.max(0, h - 1),
        );
      else if (!text) props.onEmptyKey(e.key);
    } else if (e.key === 'Enter' || (e.key === 'Tab' && listOpen)) {
      e.preventDefault();
      if (item) goQty(item, startBatch);
      else if (text.trim()) void pickHighlighted();
    } else if (e.key === 'Escape') {
      if (text || item) {
        e.preventDefault();
        reset();
      }
    } else if (!text && (e.key === 'Delete' || e.key === '+' || e.key === '-')) {
      e.preventDefault();
      props.onEmptyKey(e.key);
    }
  }

  async function onQtyEnter() {
    if (!item) return reset();
    let parsed: ParsedQty;
    try {
      parsed = parseQtyInput(qtyText || '1', {
        allowLoose: item.allowLooseSale,
        packSize: item.packSize,
        unitAllowsDecimal: item.unit.allowsDecimal,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the qty.');
      return;
    }
    setError('');
    if (parsed.kind === 'LOOSE') {
      let it = item;
      const mix = it.mix!;
      const here = D(mix.litersHere).minus(litersOnBill(props.existing, mix.subProductId));
      if (here.lessThan(D(parsed.liters))) {
        const refreshed = await props.onOpenCan(it, D(parsed.liters).minus(here).toFixed(3));
        if (!refreshed) {
          setError(`Only ${formatQty(here)} L of mix paint here. Open a can first.`);
          return;
        }
        it = refreshed;
        setItem(refreshed);
      }
      setLoose(parsed);
      setPriceText(props.wholesale ? it.mix!.wPricePerLiter : it.mix!.pricePerLiter);
      setStep('price');
      focusStep('price');
      return;
    }
    setLoose(null);
    setUnitsQty(parsed.qty);
    if (props.wholesale) return addUnits(parsed.qty);
    setStep('discount');
    focusStep('discount');
  }

  function addUnits(qty: string) {
    if (!item) return;
    try {
      const cleanDisc = discText.trim().replace('%', '').trim();
      let typed: string;
      if (cleanDisc === '' || discText.trim() === defaultDisc) {
        typed = defaultDisc === '0%' ? '0%' : '';
      } else {
        typed = `${cleanDisc}%`;
      }
      const lines = splitIntoBatchLines(item, qty, startBatch, typed, props.existing);
      for (const l of lines) {
        const p = priceBillLine(l, props.wholesale);
        if (p.error) {
          setError(p.error);
          focusStep('discount');
          return;
        }
      }
      props.onAdd(lines);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check this line.');
      focusStep('qty');
    }
  }

  async function addLoose() {
    if (!item?.mix || !loose) return;
    const base = props.wholesale ? item.mix.wPricePerLiter : item.mix.pricePerLiter;
    const typed = priceText.trim().replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
      setError('Type the price per liter.');
      return;
    }
    const changed = !D(typed).equals(D(base));
    if (changed && !(await props.onPriceApproval())) {
      setPriceText(base);
      focusStep('price');
      return;
    }
    props.onAdd([
      {
        key: newKey(),
        kind: 'LOOSE',
        item,
        batch: null,
        qty: loose.liters,
        discountText: '',
        pricePerLiter: changed ? D(typed).toFixed(2) : null,
      },
    ]);
    reset();
  }

  const batch = item?.batches.find((b) => b.id === startBatch);
  const shownPrice = loose
    ? props.wholesale
      ? item?.mix?.wPricePerLiter
      : item?.mix?.pricePerLiter
    : batch
      ? props.wholesale
        ? batch.wPrice
        : batch.rPrice
      : null;

  return (
    <div className="relative">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_110px_120px] gap-2">
        <label className="sr-only" htmlFor="item-code">
          Item code
        </label>
        <Input
          id="item-code"
          ref={codeRef}
          placeholder="Item code (F2)"
          autoComplete="off"
          value={codeText}
          onFocus={() => setField('code')}
          onChange={(e) => {
            setField('code');
            setItem(null);
            setCodeText(e.target.value);
            setHi(0);
            setError('');
          }}
          onKeyDown={onItemKey}
          className="h-12 border-2 text-base"
        />
        <label className="sr-only" htmlFor="item-name">
          Item name
        </label>
        <Input
          id="item-name"
          ref={nameRef}
          placeholder="Item name"
          autoComplete="off"
          value={nameText}
          onFocus={() => setField('name')}
          onChange={(e) => {
            setField('name');
            setItem(null);
            setNameText(e.target.value);
            setHi(0);
            setError('');
          }}
          onKeyDown={onItemKey}
          className="h-12 text-base"
        />
        <label className="sr-only" htmlFor="item-qty">
          Qty
        </label>
        <Input
          id="item-qty"
          ref={qtyRef}
          placeholder="Qty"
          autoComplete="off"
          value={qtyText}
          disabled={!item}
          onChange={(e) => setQtyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onQtyEnter();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              reset();
            }
          }}
          className="num h-12 text-base"
        />
        {step === 'price' ? (
          <>
            <label className="sr-only" htmlFor="item-price">
              Price per liter
            </label>
            <Input
              id="item-price"
              ref={priceRef}
              autoComplete="off"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addLoose();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  reset();
                }
              }}
              className="num h-12 border-2 border-accent text-base"
            />
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="item-discount">
              Discount (%)
            </label>
            <Input
              id="item-discount"
              ref={discRef}
              placeholder="Discount (%)"
              autoComplete="off"
              value={discText}
              disabled={!item || step !== 'discount'}
              onFocus={() => {
                discRef.current?.select();
              }}
              onChange={(e) => setDiscText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addUnits(unitsQty);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setStep('qty');
                  focusStep('qty');
                }
              }}
              className="num h-12 text-base"
            />
          </>
        )}
      </div>

      <div className="mt-1.5 flex min-h-6 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {item ? (
          <span className="text-muted">
            {loose ? (
              <>
                {item.mix?.name}, loose · {loose.display} · Rs {formatMoney(shownPrice)} per L ·{' '}
                {formatQty(item.mix?.litersHere)} L in mix paint
                <span className="ml-2 text-text">
                  Enter keeps the price; changing it needs an Admin PIN.
                </span>
              </>
            ) : (
              <>
                {batch ? `${batch.code} · ` : ''}Rs {formatMoney(shownPrice)} ·{' '}
                {formatQty(item.stockHere)} {item.unit.name} here
                {batch && !props.wholesale
                  ? ` · up to ${
                      D(batch.rPrice).greaterThan(0)
                        ? D(batch.maxDiscount)
                            .dividedBy(D(batch.rPrice))
                            .times(100)
                            .toDecimalPlaces(1)
                            .toString()
                        : '0'
                    }% off (max Rs ${formatMoney(batch.maxDiscount)})`
                  : ''}
                {item.allowLooseSale ? ' · type L after the qty to sell loose (1.5L)' : ''}
              </>
            )}
          </span>
        ) : (
          <span className="text-muted">
            Type a code or a name, pick with ↑↓ and press Enter. <Kbd>Esc</Kbd> clears.
          </span>
        )}
        {error ? (
          <span role="alert" className="font-medium text-danger">
            {error}
          </span>
        ) : null}
        {error && item && props.canMoveStock && item.elsewhere.length > 0 ? (
          <button
            className="font-medium text-accent-strong underline"
            onClick={() => props.onMoveFromStore(item)}
          >
            Move 1 from {item.elsewhere[0]!.location}?
          </button>
        ) : null}
      </div>

      {listOpen ? (
        <ul
          role="listbox"
          aria-label="Suggestions"
          className="absolute left-0 right-0 top-[52px] z-30 max-h-80 overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-lg"
        >
          {list.map((it, i) => (
            <li
              key={it.productId}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
              onMouseEnter={() => setHi(i)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-4 px-3 py-2',
                i === hi && 'bg-selected',
              )}
            >
              <span className="min-w-0 truncate">
                <span className="font-semibold">{it.code}</span> · {it.name}
              </span>
              <span className="num shrink-0 text-sm text-muted">
                {it.batches[0]
                  ? `Rs ${formatMoney(props.wholesale ? it.batches[0].wPrice : it.batches[0].salesPrice)}`
                  : 'none here'}{' '}
                · {formatQty(it.stockHere)} {it.unit.name}
                {it.mix ? ` · ${formatQty(it.mix.litersHere)} L loose` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {picker ? (
        <BatchPicker
          item={picker}
          wholesale={props.wholesale}
          onPick={(id) => {
            const it = picker;
            setPicker(null);
            goQty(it, id);
          }}
          onClose={() => {
            setPicker(null);
            reset();
          }}
        />
      ) : null}
    </div>
  );
});
