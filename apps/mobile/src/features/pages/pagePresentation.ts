import { createContext } from "react";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const PAGE_ICON = "doc.richtext" satisfies AppSymbolName;

/** Whether the feed row around a page is in view, by `htmlRenderFrameInView`. */
export const HtmlRenderInViewContext = createContext(false);
