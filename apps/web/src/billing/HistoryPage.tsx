import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/ui/misc';
import { HistoryPanel } from './HistoryPanel';

export function HistoryPage() {
  const [params] = useSearchParams();
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Bill history"
        description="P reprint · R return · C convert a quotation · V void (same day, Admin PIN) · D delete a quotation."
      />
      <div className="min-h-0 flex-1">
        <HistoryPanel initialOpenId={params.get('open')} />
      </div>
    </div>
  );
}
