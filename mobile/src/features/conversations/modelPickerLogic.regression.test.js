/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The model picker, New's and an open chat's: the desktop's CliModelPicker on
// a phone. One row per model family, the CLI's own default first, the window
// as a second choice on a family's row, a search that spans every provider,
// and an effort ramp only where the CLI declares levels and the desktop takes
// one.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  DESKTOP_DEFAULT_LABEL,
  EFFORT_UNSET_LABEL,
  NOT_LISTED_NOTE,
  chatProvider,
  choosePickerRow,
  costliestEffort,
  effortLabel,
  effortStops,
  initialPickerFilter,
  keptEffort,
  meaningfulModelId,
  modelFamilies,
  newChatProviders,
  parseModelWindow,
  pickedWindowLabel,
  pickerLabel,
  pickerRowDetail,
  pickerRowSelected,
  pickerSearchOffered,
  providerRows,
  readOnlyProvider,
  visiblePickerRows,
  windowChoices,
} = require(path.join(buildRoot, "src/features/conversations/modelPickerLogic.js"));
const { readCliRuntimes } = require(path.join(buildRoot, "src/features/conversations/launchLogic.js"));

// What a desktop that advertises `cli-runtime-catalog` answers, read as the
// phone reads it.
const catalogRuntimes = readCliRuntimes({
  clis: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [{ id: "claude-opus-5", label: "Opus 5" }],
      reasoningLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      defaultReasoningLevel: "high",
      catalog: {
        conversational: true,
        hostedVia: null,
        providerLabel: "Claude Code",
        allowCustomModelId: true,
        models: [
          { id: "claude-opus-5", label: "Opus 5", family: "claude-opus-5", familyDefault: true, contextLabel: "Standard", origin: "discovered" },
          { id: "claude-opus-5[1m]", label: "Opus 5 (1M)", family: "claude-opus-5", familyDefault: false, contextLabel: "1M", origin: "discovered" },
          { id: "claude-fable-5", label: "Fable 5", family: "claude-fable-5", familyDefault: true, contextLabel: "Standard", isNew: true, origin: "discovered" },
          { id: "opus[1m]", label: "Opus (latest, 1M context)", family: "opus", familyDefault: true, contextLabel: "1M", origin: "manifest" },
        ],
      },
    },
    {
      id: "kimi-claude",
      displayName: "Kimi",
      agentSelectable: true,
      supportsModelSelection: false,
      models: [],
      catalog: { conversational: true, hostedVia: "claude-code", providerLabel: "Kimi · via Claude Code", allowCustomModelId: false, models: [] },
    },
    {
      id: "codex",
      displayName: "Codex",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      reasoningLevels: [{ id: "low" }, { id: "medium", label: "Medium" }, { id: "xhigh", label: "Extra high" }],
      defaultReasoningLevel: "medium",
      catalog: {
        conversational: true,
        hostedVia: null,
        providerLabel: "Codex",
        allowCustomModelId: false,
        models: [{ id: "gpt-5.5", label: "GPT-5.5", family: "gpt-5.5", familyDefault: true, contextLabel: "Standard", origin: "manifest" }],
      },
    },
    {
      id: "aider",
      displayName: "Aider",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [{ id: "sonnet" }],
      catalog: { conversational: false, hostedVia: null, providerLabel: "Aider", allowCustomModelId: true, models: [] },
    },
  ],
});

test("cli.runtime.list's catalog, levels and default level are read, and a malformed catalog is dropped whole", () => {
  const claude = catalogRuntimes.find((runtime) => runtime.id === "claude-code");
  assert.equal(claude.catalog.conversational, true);
  assert.equal(claude.catalog.models.length, 4);
  assert.equal(claude.catalog.models[2].isNew, true);
  assert.equal("isNew" in claude.catalog.models[0], false);
  assert.equal(claude.defaultReasoningLevel, "high");
  // A level with no label is named by its id.
  const codex = catalogRuntimes.find((runtime) => runtime.id === "codex");
  assert.deepEqual(codex.reasoningLevels[0], { id: "low", label: "low" });
  assert.equal(catalogRuntimes.find((runtime) => runtime.id === "kimi-claude").catalog.hostedVia, "claude-code");

  const [odd] = readCliRuntimes({
    clis: [
      {
        id: "x",
        agentSelectable: true,
        // A default that is not one of the levels is no default.
        reasoningLevels: [{ id: "low" }],
        defaultReasoningLevel: "ultra",
        // No providerLabel: not the documented shape, so no catalog at all.
        catalog: { conversational: true, models: [] },
      },
    ],
  });
  assert.equal("catalog" in odd, false);
  assert.equal("defaultReasoningLevel" in odd, false);
  // A CLI that declares no levels carries none.
  const [none] = readCliRuntimes({ clis: [{ id: "y", agentSelectable: true, reasoningLevels: [] }] });
  assert.equal("reasoningLevels" in none, false);
});

test("a model's windows are one family row, named and selected by the id the catalog says", () => {
  assert.deepEqual(parseModelWindow("claude-opus-5[1m]"), { baseId: "claude-opus-5", window: "1m" });
  assert.deepEqual(parseModelWindow("gpt-5.5"), { baseId: "gpt-5.5" });

  const families = modelFamilies(catalogRuntimes[0].catalog.models);
  assert.deepEqual(
    families.map((family) => [family.key, family.defaultId, family.label, family.variants.map((variant) => variant.label), family.isNew]),
    [
      ["claude-opus-5", "claude-opus-5", "Opus 5", ["Standard", "1M"], false],
      ["claude-fable-5", "claude-fable-5", "Fable 5", ["Standard"], true],
      // Shipped only suffixed: it keeps its own id and name in both roles.
      ["opus", "opus[1m]", "Opus (latest, 1M context)", ["1M"], false],
    ],
  );
});

test("without a catalog the same rule groups bare ids, the un-suffixed id naming the row", () => {
  const families = modelFamilies([
    { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "gpt-5.5" },
  ]);
  assert.equal(families.length, 2);
  assert.equal(families[0].defaultId, "claude-opus-5");
  assert.equal(families[0].label, "Opus 5");
  // Base window first, whatever order the catalog listed them in.
  assert.deepEqual(families[0].variants.map((variant) => variant.id), ["claude-opus-5", "claude-opus-5[1m]"]);
  assert.equal(families[1].label, undefined);
});

test("a CLI's rows: its own default first under its name, then one per family, and a dropped model as Not listed", () => {
  const rows = providerRows({
    cli: "claude-code",
    label: "Claude Code",
    providerLabel: "Claude Code",
    models: [{ id: "claude-opus-5", label: "Opus 5" }, { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" }, { id: "opus[1m]", label: "Opus" }, { id: "sonnet-x" }],
    current: "claude-haiku-4",
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.model, row.mono, row.detailId ?? null, row.note ?? null]),
    [
      ["Claude Code", null, false, null, null],
      // The id carries the vendor the name leaves out, so it is shown.
      ["Opus 5", "claude-opus-5", false, "claude-opus-5", null],
      // The id says what the name does not: the window.
      ["Opus", "opus[1m]", false, "opus[1m]", null],
      // Nothing named it: the id is the name, in mono.
      ["sonnet-x", "sonnet-x", true, null, null],
      ["claude-haiku-4", "claude-haiku-4", true, null, NOT_LISTED_NOTE],
    ],
  );
  assert.equal(meaningfulModelId("gpt-5.5", "GPT-5.5"), undefined);
  assert.equal(meaningfulModelId("opus[1m]", "Opus"), "opus[1m]");
});

test("New's rail: the conversational CLIs with the catalog, each with its provider line and its levels", () => {
  const providers = newChatProviders(catalogRuntimes, { catalog: true, effort: true });
  // Aider cannot run as a chat; Kimi has no models of its own but is still a
  // CLI to start a chat on, at its own default.
  assert.deepEqual(providers.map((provider) => provider.cli), ["claude-code", "kimi-claude", "codex"]);
  assert.equal(providers[1].providerLabel, "Kimi · via Claude Code");
  assert.deepEqual(providers[1].rows.map((row) => row.name), ["Kimi"]);
  assert.deepEqual(
    providers[0].rows.map((row) => [row.name, row.isNew]),
    [
      ["Claude Code", false],
      ["Opus 5", false],
      ["Fable 5", true],
      ["Opus (latest, 1M context)", false],
    ],
  );
  assert.deepEqual(providers[2].levels.map((level) => level.id), ["low", "medium", "xhigh"]);
  assert.equal(providers[2].defaultLevel, "medium");

  // A desktop that does not take an effort offers no levels: none could be sent.
  assert.deepEqual(newChatProviders(catalogRuntimes, { catalog: true, effort: false })[2].levels, []);
  assert.equal(newChatProviders(catalogRuntimes, { catalog: true, effort: false })[2].defaultLevel, null);
});

test("an older desktop's rail is what New offered before: the CLIs that list models, from that list", () => {
  const providers = newChatProviders(catalogRuntimes, { catalog: false, effort: false });
  // No catalog read: Kimi lists no models, and Aider is offered as it was.
  assert.deepEqual(providers.map((provider) => provider.cli), ["claude-code", "codex", "aider"]);
  assert.deepEqual(providers[0].rows.map((row) => row.model), [null, "claude-opus-5"]);
  assert.equal(providers[0].providerLabel, "Claude Code");
});

test("a query searches every provider at once; without one the list is the rail's provider", () => {
  const providers = newChatProviders(catalogRuntimes, { catalog: true, effort: true });
  const railed = visiblePickerRows(providers, { filter: "codex", query: "" });
  assert.equal(railed.searching, false);
  assert.deepEqual(railed.rows.map((row) => row.name), ["Codex", "GPT-5.5"]);
  // An unknown filter falls back to the first provider.
  assert.equal(visiblePickerRows(providers, { filter: "gone", query: "" }).rows[0].cli, "claude-code");

  const searched = visiblePickerRows(providers, { filter: "codex", query: " opus " });
  assert.equal(searched.searching, true);
  assert.deepEqual(searched.rows.map((row) => row.name), ["Opus 5", "Opus (latest, 1M context)"]);
  // The provider line is searched too: "via claude" finds the hosted runtime.
  assert.deepEqual(visiblePickerRows(providers, { filter: null, query: "via claude" }).rows.map((row) => row.cli), ["kimi-claude"]);
  // And the id: a window variant's own id finds its family row.
  assert.deepEqual(visiblePickerRows(providers, { filter: null, query: "gpt-5" }).rows.map((row) => row.name), ["GPT-5.5"]);
  assert.deepEqual(visiblePickerRows(providers, { filter: null, query: "nothing like it" }).rows, []);

  assert.equal(initialPickerFilter(providers, { cli: "codex", model: null }), "codex");
  assert.equal(initialPickerFilter(providers, { cli: null, model: null }), "claude-code");
  assert.equal(initialPickerFilter([], { cli: null, model: null }), null);
});

test("a family row is picked whichever window is; picking it again keeps the window", () => {
  const [, opus] = newChatProviders(catalogRuntimes, { catalog: true, effort: true })[0].rows;
  const onWide = { cli: "claude-code", model: "claude-opus-5[1m]" };
  assert.equal(pickerRowSelected(opus, onWide), true);
  assert.equal(pickerRowSelected(opus, { cli: "codex", model: "claude-opus-5[1m]" }), false);
  assert.deepEqual(choosePickerRow(opus, onWide), onWide, "re-choosing the family must not drop the 1M window");
  assert.deepEqual(choosePickerRow(opus, { cli: "codex", model: null }), { cli: "claude-code", model: "claude-opus-5" });
  assert.deepEqual(windowChoices(opus).map((variant) => [variant.id, variant.label, variant.base]), [
    ["claude-opus-5", "Standard", true],
    ["claude-opus-5[1m]", "1M", false],
  ]);

  const cliDefault = newChatProviders(catalogRuntimes, { catalog: true, effort: true })[0].rows[0];
  assert.equal(pickerRowSelected(cliDefault, { cli: "claude-code", model: null }), true);
  assert.equal(pickerRowSelected(cliDefault, { cli: null, model: null }), false, "Desktop default is not the CLI's default");
  assert.deepEqual(choosePickerRow(cliDefault, onWide), { cli: "claude-code", model: null });
  assert.deepEqual(windowChoices(cliDefault), []);
});

test("the trigger names the model, the CLI for its own default, and Desktop default for nothing picked", () => {
  const providers = newChatProviders(catalogRuntimes, { catalog: true, effort: true });
  assert.equal(pickerLabel(providers, { cli: null, model: null }, DESKTOP_DEFAULT_LABEL), "Desktop default");
  assert.equal(pickerLabel(providers, { cli: "codex", model: null }, DESKTOP_DEFAULT_LABEL), "Codex");
  assert.equal(pickerLabel(providers, { cli: "claude-code", model: "claude-opus-5[1m]" }, DESKTOP_DEFAULT_LABEL), "Opus 5");
  assert.equal(pickerLabel(providers, { cli: "claude-code", model: "custom-id" }, DESKTOP_DEFAULT_LABEL), "custom-id");
  assert.equal(pickedWindowLabel(providers, { cli: "claude-code", model: "claude-opus-5[1m]" }), "1M");
  assert.equal(pickedWindowLabel(providers, { cli: "claude-code", model: "claude-fable-5" }), null);
});

test("an open chat offers its own CLI's models, matched to the catalog by id for families and New marks", () => {
  const models = {
    cli: "claude-code",
    cliLabel: "Claude Code",
    liveModelSwitch: true,
    options: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-opus-5[1m]" },
      { id: "claude-fable-5" },
      { id: "local-only", label: "Local" },
    ],
  };
  const provider = chatProvider(models, catalogRuntimes[0], "claude-opus-5[1m]");
  assert.equal(provider.cli, "claude-code");
  assert.deepEqual(provider.levels, [], "a chat's effort is not switchable over the wire");
  assert.deepEqual(
    provider.rows.map((row) => [row.name, row.model, row.isNew, windowChoices(row).map((variant) => variant.label)]),
    [
      ["Claude Code", null, false, []],
      ["Opus 5", "claude-opus-5", false, ["Standard", "1M"]],
      // Unlabelled in the chat's list: the catalog names it, and marks it New.
      ["Fable 5", "claude-fable-5", true, []],
      ["Local", "local-only", false, []],
    ],
  );
  assert.equal(pickerRowSelected(provider.rows[1], { cli: "claude-code", model: "claude-opus-5[1m]" }), true);

  // With no catalog the chat's own list still groups by the window suffix.
  const bare = chatProvider(models, null, null);
  assert.deepEqual(bare.rows.map((row) => row.name), ["Claude Code", "Opus 5", "claude-fable-5", "Local"]);
  assert.equal(bare.providerLabel, "Claude Code");
});

test("the effort ramp: Auto first, the CLI's levels after it, the last one the costliest", () => {
  const levels = catalogRuntimes.find((runtime) => runtime.id === "codex").reasoningLevels;
  assert.deepEqual(
    effortStops(levels).map((stop) => [stop.id, stop.label]),
    [
      [null, EFFORT_UNSET_LABEL],
      ["low", "low"],
      ["medium", "Medium"],
      ["xhigh", "Extra high"],
    ],
  );
  assert.equal(effortLabel(levels, "xhigh"), "Extra high");
  assert.equal(effortLabel(levels, null), "Auto");
  assert.equal(effortLabel(levels, "max"), "Auto", "a level the CLI does not declare reads as none");
  assert.equal(costliestEffort(levels), "xhigh");
  assert.equal(costliestEffort([]), null);
  // A level picked on another CLI is not carried to this one.
  assert.equal(keptEffort(levels, "max"), null);
  assert.equal(keptEffort(levels, "medium"), "medium");
  assert.equal(keptEffort([], "medium"), null);
});

test("a chat the desktop lists no models for shows its model alone, and nothing to search", () => {
  const provider = readOnlyProvider({ cli: "codex", label: "Codex", modelName: "GPT-5.5" });
  assert.deepEqual(provider.rows.map((row) => row.name), ["GPT-5.5"]);
  assert.equal(pickerRowSelected(provider.rows[0], { cli: "codex", model: null }), true);
  assert.equal(pickerSearchOffered([provider], true), false);
  assert.equal(pickerSearchOffered([provider], false), false, "one row is no choice to search");
  const providers = newChatProviders(catalogRuntimes, { catalog: true, effort: true });
  assert.equal(pickerSearchOffered(providers, false), true);
  assert.equal(pickerSearchOffered(providers, true), false, "a list that cannot be picked from is not searched");
});

test("a row's second line qualifies its name and never restates it, as the desktop's does", () => {
  // The desktop's own cases.
  assert.equal(meaningfulModelId("opus[1m]", "Opus"), "opus[1m]");
  assert.equal(meaningfulModelId("gpt-5.5", "GPT-5.5"), undefined);
  assert.equal(meaningfulModelId("opus[1m]", undefined), undefined);
  // Separators and case do not count: the name spells the id.
  assert.equal(meaningfulModelId("claude-opus-5-5", "Claude Opus 5.5"), undefined);
  // A vendor namespace the name leaves out is kept, as the desktop keeps it.
  assert.equal(meaningfulModelId("claude-opus-5-5", "Opus 5.5"), "claude-opus-5-5");

  const providers = newChatProviders(catalogRuntimes, { catalog: true, effort: true });
  const codex = providers.find((provider) => provider.cli === "codex");
  const [codexDefault, gpt] = codex.rows;
  // Under the rail: the CLI's own row and a model its name spells have none.
  assert.equal(pickerRowDetail(codexDefault, { spansProviders: false }), "");
  assert.equal(pickerRowDetail(gpt, { spansProviders: false }), "");
  // Under a search the provider joins, except on the CLI's own row, whose name is the provider.
  assert.equal(pickerRowDetail(gpt, { spansProviders: true }), "Codex");
  assert.equal(pickerRowDetail(codexDefault, { spansProviders: true }), "");
  const opusLatest = providers[0].rows.find((row) => row.model === "opus[1m]");
  assert.equal(pickerRowDetail(opusLatest, { spansProviders: false }), "opus[1m]");
  assert.equal(pickerRowDetail(opusLatest, { spansProviders: true }), "Claude Code · opus[1m]");
});
