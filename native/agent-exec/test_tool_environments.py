import os
from pathlib import Path
import tempfile
import unittest

import tool_environments

DAY = 24 * 3600


class PruneGenerationsTests(unittest.TestCase):
    def test_keeps_newest_and_recent_generations(self):
        now = 1_000 * DAY
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            ages = {"a": 1, "b": 2, "c": 3, "d": 5, "e": 20, "f": 30}
            for name, age in ages.items():
                generation = project / name
                generation.mkdir()
                (generation / "profile").symlink_to("/nix/store/missing-profile")
                environment = generation / "environment.json"
                environment.write_text("{}")
                os.utime(environment, (now - age * DAY, now - age * DAY))
            (project / "building").mkdir()

            tool_environments.prune_generations(project, now=now)

            self.assertEqual(
                sorted(path.name for path in project.iterdir()),
                ["a", "b", "building", "c", "d"],
            )


if __name__ == "__main__":
    unittest.main()
