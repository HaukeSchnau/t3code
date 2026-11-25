import { Text } from "../ui/text";
import { ComposerBanner } from "./ComposerBanner";

/** What happens after a thread error, such as an automatic retry, under the notice's line. */
export function ThreadErrorDetail({ detail }: { readonly detail: string }) {
  return (
    <ComposerBanner.Body>
      <Text variant="meta" tone="muted" render={<p />}>
        {detail}
      </Text>
    </ComposerBanner.Body>
  );
}
