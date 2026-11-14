/**
 * R21 (UX-9): honesty prose, folded. The views carry many caveats: how old a
 * read is, why a stream gap cannot be recovered, why a drawn edge count and a
 * served count disagree. Each one is a fact the reader is owed. Printed as full
 * paragraphs, up to five of them stood between the reader and the tree, and
 * the answer the page exists to give scrolled below the explanation of how far
 * to trust it.
 *
 * The rule here is "change the form, keep every fact". The headline stays
 * visible (that a read is aged, that frames went missing, that a picture has
 * caveats), and the full sentences move into a native `<details>` disclosure.
 * A closed `<details>` still keeps its content in the document, so text search
 * and an `aria-describedby` that points inside it still reach every sentence.
 * Nothing here decides whether a caveat applies: callers render this only when
 * their own condition holds, the same as before.
 */
import type { ReactNode } from 'react';

/** A disclosure holding the full wording of a caveat whose headline is shown. */
export function CaveatDetails({
  summary,
  children,
  testId,
}: {
  /** The disclosure label, e.g. `why` or `2 caveats about this picture`. */
  readonly summary: string;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <details className="caveat-details" data-testid={testId}>
      <summary>{summary}</summary>
      <div className="caveat-body">{children}</div>
    </details>
  );
}

/** `1 caveat`, `3 caveats` - for a group of quiet notes under one disclosure. */
export function caveatCountLabel(count: number, about: string): string {
  return `⚠ ${String(count)} ${count === 1 ? 'caveat' : 'caveats'} ${about}`;
}
