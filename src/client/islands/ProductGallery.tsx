import { useState } from 'react';

export function ProductGallery({ images, name }: { images: Array<{ url: string; alt: string }>; name: string }) {
  const [i, setI] = useState(0);
  const list = images.length ? images : [{ url: '/images/placeholder.svg', alt: `${name} — image coming soon` }];
  const cur = list[Math.min(i, list.length - 1)];
  return (
    <div className="grid gap-3">
      <div className="art">
        <img src={cur.url} alt={cur.alt} width={800} height={1000} fetchPriority="high" />
      </div>
      {list.length > 1 ? (
        <div className="flex gap-2" role="group" aria-label="Product images">
          {list.map((img, k) => (
            <button
              key={img.url}
              type="button"
              className={`art w-16 rounded-lg border-2 ${k === i ? 'border-[var(--color-forest-700)]' : 'border-transparent'}`}
              aria-label={`Show image ${k + 1} of ${list.length}`}
              aria-pressed={k === i}
              onClick={() => setI(k)}
            >
              <img src={img.url} alt="" width={64} height={80} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
