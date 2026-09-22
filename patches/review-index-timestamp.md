# Review index timestamps

Review previews copy the Git index to include untracked files without changing the user's staging
area. Preserve the source index's modification time before running Git against the copy. Git uses
that timestamp to decide when matching file metadata still requires a content comparison. Giving
the copy a newer timestamp can hide same-size edits made within the filesystem's timestamp
resolution.

Keep this fix until upstream preserves that timestamp or replaces the temporary-index approach
with one that retains Git's detection of these edits. The regression test models unchanged file
metadata and checks both the preview and the untouched source index.
