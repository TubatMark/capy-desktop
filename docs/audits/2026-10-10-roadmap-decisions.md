# Roadmap execution decisions

These decisions resolve planning ambiguities during autonomous implementation. Evidence is separate in [the execution audit](2026-10-10-roadmap-execution.md). The decisions below include the final integration and validation corrections.

1. **Use an isolated worktree without another confirmation.** This follows the request for autonomous execution and preserves the original checkout. A wrong workspace choice would require moving the commits.

2. **Keep automatic publication disabled until release proof exists.** Implementation authorization does not establish live account eligibility or authorize spending. The cost is a separate real soak and controlled upload before enablement.

3. **Use immutable hashes, compare-and-swap revisions and worker fences.** Approvals must survive downstream edits without silently authorizing changed content. The cost is additional schema and integration work.

4. **Extract A1/B1-style task headings with an equivalent parser.** The skill helper recognizes only numbered Task headings. Requirements were preserved; the cost is maintaining the custom extraction artifact.

5. **Run the B1 renderer experiment alongside A1.** The roadmap allows early evaluation and the user requested parallel agents. Disjoint ownership and serialized commits reduce the remaining integration risk.

6. **Start A2 storage work while A1 finishes.** Queue integration waited for the publication contract. The cost of an incorrect dependency assumption would be integration rework.

7. **Define deterministic sampling for fractional source times.** Microsecond boundaries need not align with output frames. A wrong policy would require source-frame alignment corrections.

8. **Run A4 against the stable transactional storage API before packaging.** The work did not change database or job-lifecycle internals. The cost would be API integration rework.

9. **Distinguish application AI budgets from provider-enforced usage limits.** Application mode bounds admitted runs, retries, timeouts and reservations; unknown internal provider usage remains unknown. Strict mode rejects unverified enforcement. The risk is actual usage exceeding estimates in application mode.

10. **Judge A3 by its behavioral contract rather than unused inventory files.** The active poster and fetch context received the controls. The risk is an overlooked external compatibility dependency, retained for final review.

11. **Run C1 source-account import alongside worker/editor reviews.** Reading-account work was independent of editor and publishing credentials. The cost would be shared-type integration rework.

12. **Start B5 with legacy artifact identity before B4.** The future project revision and artifact contract was defined first; final integration remained a gate. The cost would be source-provenance integration rework.

13. **Extend B4 with explicit Studio queue identity.** Optional project fields were insufficient while queue code assumed legacy jobs. This requires more queue compatibility checks but prevents fabricated legacy identities.

14. **Anchor rich mixed-rate exports to the requested source clock.** Nearest-presentation normalization avoids a measured 40.7 ms shift on a 24 fps source trimmed by 1 ms. The original bounded CFR sampling test remains separate. The cost is maintaining two explicit sampling policies.

15. **Preserve enabled legacy monitoring as bounded draft production.** Unset new policy must not silently pause previously enabled discovery. Explicit manual policy still defers production. The risk is additional draft work during migration, bounded by admission limits and publication gates.

16. **Use manually confirmed source regions for speaker framing.** No supported automatic detector was established. Confirmation is bound to source checksum and span, and speaker changes require splitting. The cost is manual annotation or later detector integration.

17. **Make remote scheduled upload an explicit immutable decision.** Exact publish time and upload-ahead policy are newly approved; existing approvals remain due-time. A remote intent prevents local actions from pretending to change the accepted schedule. The cost is a larger queue lifecycle integration.

18. **Defer automated intake of existing manual jobs.** Manual selections, settings, approvals and queue state take priority. Existing automated work must match its immutable admission. The cost is requiring a separate explicit workflow for an already manually processed source.

19. **Display raw provider metrics and local editorial suggestions by default.** Exact published-version grouping is preserved, but unsupported derived rankings and lift claims are unavailable. Metrics cache deletion preserves local publishing history. The cost is reduced automated analytical insight until specific capabilities and permissions are established.

20. **Use bounded local overlap-add for supported speed changes.** Measured continuous atempo drift and per-word audio loss failed the timing/content contract. The replacement has decoded timing, pitch, stereo, short-span and cancellation tests; arbitrary perceptual transparency is unverified. The risk is audio-quality or performance rework.

21. **Run C5 against the reviewed attribution interface while C4 durability fixes finish.** Metrics do not consume private session handles or create remote intents. Delivery release gates stay closed. The cost is possible projection integration rework.

The metrics decision follows the current [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies); account access and live analytics remain unverified.

22. **Build the isolated soak harness in parallel with delivery integration.** Its fixture injection and worker contracts are stable, and its files are separately owned. The cost is possible harness integration rework; full delivery review is still required.

23. **Use provider-returned values in the adjacent Channel overview.** Locally weighted retention and calculated trends would conflict with the new raw-metric view and could use incomplete video lists. Unsupported summaries become unavailable. Existing explicit SEO research remains a separate follow-up; C5 does not invoke it. The cost is fewer overview comparisons or later scoped SEO work.

24. **Commit delivery and metrics integration together.** Their new token and cache-purge interfaces depend on each other, so separate intermediate commits would not typecheck. Explicit file lists and separate task reviews preserve ownership. The cost is a coarser bisect point.

25. **Overlap broad review preparation with final task fixes.** The same reviewer must inspect the final fix delta and completed task reviews before its verdict. This follows the requested parallel execution without waiving gates. The cost is possible stale-snapshot review rework.

26. **Include automatically invoked SEO scoring in the final fixes.** Broad review found the rendering pipeline calls the old research/ranking path automatically, correcting decision 23's assumption that it was only explicit research. Use raw provider results and separate local editorial heuristics; prevent unapproved API-derived rankings from guiding automatic rewrites. The cost is reduced SEO convenience and changed metadata suggestions. No live access or general permission-management platform is authorized by this correction.

27. **Keep the branch, package and running-soak evidence locally.** The user requested autonomous work without questions and did not authorize merging or pushing. The worktree also contains tracked reports and live evidence. The cost is local storage and a later integration/cleanup step; no original work is removed.
