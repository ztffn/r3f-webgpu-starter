// Per-route document title and meta description.
//
// A client-rendered SPA keeps index.html's title on every route unless something
// sets it, so a visitor sharing /supporter would post the landing page's title.
// This is deliberately not a head-management library: two tags, one effect, and
// the description tag is updated in place rather than appended so repeated
// navigation cannot leave a stack of them behind.

import { useEffect } from "react";
import { pageTitle } from "../ui/brand";

export function useDocumentTitle(section?: string, description?: string): void {
  useEffect(() => {
    document.title = pageTitle(section);
    if (description === undefined) return;
    const tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (tag === null) return;
    const previous = tag.content;
    tag.content = description;
    return () => {
      tag.content = previous;
    };
  }, [section, description]);
}
