import { DEFAULT_SHORTCUTS, STRUCTURAL_KEYS, type ShortcutScreen } from '@aruna/shared';
import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useHotkeys, useKeymap } from './keymap';

const SCREEN_TITLES: Record<ShortcutScreen, string> = {
  global: 'Everywhere',
  billing: 'Billing',
  bill_history: 'Bill history',
  purchases: 'Purchases',
  list: 'Lists',
};

/** F1: shortcut help for the current screen, with the user's own keys. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const { maps, activeScreen } = useKeymap();
  useHotkeys('global', { help: () => setOpen((o) => !o) }, { inDialog: true });
  const screens: ShortcutScreen[] =
    activeScreen === 'global' ? ['global'] : [activeScreen, 'global'];
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Keyboard shortcuts"
      description="Change your keys under My profile."
    >
      <div className="flex flex-col gap-5">
        {screens.map((s) => (
          <section key={s}>
            <h3 className="mb-2 text-sm font-semibold text-muted">{SCREEN_TITLES[s]}</h3>
            <ul className="divide-y divide-border">
              {Object.entries(DEFAULT_SHORTCUTS[s]).map(([action, def]) => (
                <li key={action} className="flex items-center justify-between py-1.5 text-sm">
                  <span>{def.label}</span>
                  <Kbd>{maps[s][action]}</Kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-sm text-muted">
          {STRUCTURAL_KEYS.slice(0, 3).join(', ')} move between fields and close; arrows move in
          lists.
        </p>
      </div>
    </Dialog>
  );
}
