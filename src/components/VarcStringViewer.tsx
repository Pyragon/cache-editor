import type { VarcStringData } from '../loaders/config/varc_string'

type Props = {
  data: VarcStringData
}

// Client string variables have NO cache fields — every blob in the rev 727
// cache is a bare terminator, so the entry is a list of reserved ids. The
// sidebar's Add/Clone/Remove still manage which ids exist.
export default function VarcStringViewer({ data }: Props) {
  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Varc String {data.id}</span>
          <span className="item-id-badge">presence record</span>
        </div>
      </div>

      <section className="item-section">
        <p className="tex-op-note">
          Client string variables carry no configuration — the cache entry just reserves the id
          (every blob is an empty definition, and the client defines no fields for them). Scripts
          read and write the string value at runtime by this id. Use Add / Remove in the sidebar to
          manage which ids exist.
        </p>
      </section>
    </div>
  )
}
