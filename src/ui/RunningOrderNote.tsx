import type { LiveOrder } from '../lib/useLiveOrder';

/**
 * Where the running order came from, with a way to read it again.
 *
 * The order is read when the dialog opens, and AbleSet does not always have
 * written down what is on its screen by then — or the scan caught a setlist
 * mid-save. Refresh setlist rescans and asks AbleSet afresh, rather than
 * having to close the dialog and press Rescan to find out.
 */
export default function RunningOrderNote({ live, disabled }: { live: LiveOrder; disabled?: boolean }) {
  const { order, refresh, refreshing, refreshedAt } = live;
  if (!order) return null;
  return (
    <div className={order.missing ? 'notice' : 'hint'} style={{ marginBottom: 6 }}>
      {order.note || 'Reading the running order…'}{' '}
      <button
        className="btn"
        onClick={() => void refresh()}
        disabled={disabled || refreshing}
        title="Read the setlist again — from AbleSet if it has this set open, else its saved setlists"
      >
        {refreshing ? 'Reading the setlist…' : 'Refresh setlist'}
      </button>
      {refreshedAt !== null && !refreshing && (
        <span style={{ marginLeft: 6 }}>
          Read again at {new Date(refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.
        </span>
      )}
    </div>
  );
}
