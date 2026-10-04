export function Legend() {
  return (
    <section aria-label="Legend" className="glass animate-fade-in px-4 py-3 text-xs text-ink-muted">
      <h2 className="section-title mb-2">How to read the map</h2>
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2.5">
          <span className="grid w-6 place-items-center"><span className="size-3.5 rounded-full border-[1.5px] border-ink" /></span>
          With a direct report
        </li>
        <li className="flex items-center gap-2.5">
          <span className="h-0.5 w-6 rounded-full bg-prio-high shadow-[0_0_6px_var(--color-prio-high)]" />
          Exposure to an active case
        </li>
        <li className="flex items-center gap-2.5">
          <span className="w-6 border-t-[1.5px] border-dashed border-ink-muted" />
          Environmental similarity only
        </li>
      </ul>
    </section>
  )
}
