# Product research and clean-room boundary

Home OS was designed after reviewing mature open-source household and inventory products. The purpose of this research is to reuse proven product ideas, vocabulary, and workflow lessons—not source code.

## Products reviewed

| Project | Relevant pattern | License boundary |
| --- | --- | --- |
| [Homebox](https://github.com/sysadminsmedia/homebox) | Home-oriented locations, labels, photos/documents, maintenance, import/export | AGPL-3.0; behavioral reference only |
| [Grocy](https://github.com/grocy/grocy) | Purchase, consume, transfer, stocktake, minimum stock, and shopping workflows | MIT; no source imported |
| [InvenTree](https://github.com/inventree/InvenTree) | Event-backed stock history and auditable inventory operations | MIT; no source imported |
| [KitchenOwl](https://github.com/TomBursch/kitchenowl) | Roommate-oriented shopping, recipes, expenses, and partial offline behavior | AGPL-3.0; behavioral reference only |
| [Snipe-IT](https://github.com/grokability/snipe-it) | Durable-asset lifecycle, assignment, audit, and warranty concepts | AGPL-3.0; behavioral reference only |
| [Spliit](https://github.com/spliit-app/spliit) | Simple shared-expense arithmetic and household settlement UX | MIT; future expenses reference |
| [Yuvomi](https://github.com/sortedcord/yuvomi) | Broad self-hosted household dashboard and module boundaries | MIT; future Home OS reference |

## Decisions adopted

- Keep stock changes as immutable events and the current item as a projection.
- Offer both a fast household-friendly 0–100 meter and precise quantity tracking.
- Derive shopping needs from low/out inventory instead of maintaining a second conflicting list.
- Preserve archived items and their history rather than deleting household records.
- Export a versioned JSON backup before attempting transactional import.
- Keep inventory separate from contacts, expenses, chores, and household membership until those domains have their own tested boundaries.
- Apply supported commands to IndexedDB first, queue them transactionally, and reconcile with idempotent operation IDs plus optimistic versions so offline inventory remains writable.

## Source policy

Home OS is MIT licensed. No code, assets, database schema, or text was copied from the reviewed applications. AGPL projects are never used as implementation dependencies or source donors. Any future source reuse requires an explicit compatibility review, attribution, and a repository license decision before code is introduced.
