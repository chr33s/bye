// Type-only view of the Worker classes the stack binds (§7.5). These imports are erased from the
// deployment bundle; deployment code never imports runtime modules, and the Worker bundle never
// imports this file (enforced by infra/policies/check-boundaries.ts).
import type {
  CalendarDO,
  IngressJournalDO,
  MailboxDO,
  SearchShardDO,
  SharedSpaceDO,
} from "../../workers/core/src/objects.ts";
import type { ScannerContainer } from "../../workers/core/src/scan.ts";
import type { MimeContainer } from "../../workers/core/src/mime.ts";
import type { ProbeDO } from "../../workers/core/src/probe.ts";

export interface CoreClasses {
  readonly MailboxDO: MailboxDO;
  readonly CalendarDO: CalendarDO;
  readonly SharedSpaceDO: SharedSpaceDO;
  readonly SearchShardDO: SearchShardDO;
  readonly IngressJournalDO: IngressJournalDO;
  readonly ScannerContainer: ScannerContainer;
  readonly MimeContainer: MimeContainer;
  readonly ProbeDO: ProbeDO;
}
