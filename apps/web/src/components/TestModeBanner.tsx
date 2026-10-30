/**
 * For a user in test mode, every screen has a red frame and a "TEST MODE" tab at the top, so
 * nobody mistakes a test bill for a real one. It never takes clicks or keys.
 */
export function TestModeBanner() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[70] border-4 border-danger"
      />
      <div
        role="status"
        className="pointer-events-none fixed left-1/2 top-0 z-[70] -translate-x-1/2 rounded-b-[8px] bg-danger px-3 text-xs font-bold leading-[18px] text-white shadow-md"
      >
        TEST MODE · nothing here is real
      </div>
    </>
  );
}
