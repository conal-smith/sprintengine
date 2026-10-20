import { useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { PrimaryButton } from "../../components/PrimaryButton";
import { useTheme } from "../../theme/ThemeProvider";
import type {
  MobileControlBacklogItemCriticality,
  MobileControlBacklogItemDifficulty,
  MobileControlBacklogItemType,
} from "../../shared/mobile-control";
import {
  backlogCreateCriticalityOptions,
  backlogCreateDescriptionMaxChars,
  backlogCreateDifficultyOptions,
  backlogCreateTitleMaxChars,
  backlogCreateTypeOptions,
  buildBacklogCreatePayload,
  type BacklogCreateWorkspaceOption,
} from "./backlogLogic";
import {
  capitalizeToken,
  OptionRow,
  useCreateFormStyles,
  WorkspacePicker,
  type CreateFormState,
} from "./createFormShared";

export interface BacklogCreateInput {
  workspacePath: string;
  title: string;
  description?: string;
  type?: MobileControlBacklogItemType;
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
}

export interface BacklogCreateResult {
  relativePath?: string;
}

interface BacklogCreateFormProps {
  workspaces: BacklogCreateWorkspaceOption[];
  /** The app's current project — the workspace the form opens on. */
  defaultWorkspacePath?: string | null;
  isLoading: boolean;
  onCreate: ((input: BacklogCreateInput) => Promise<BacklogCreateResult>) | null;
  onClose: () => void;
}

export function BacklogCreateForm({
  workspaces,
  defaultWorkspacePath = null,
  isLoading,
  onCreate,
  onClose,
}: BacklogCreateFormProps) {
  const { colors } = useTheme();
  const createFormStyles = useCreateFormStyles();
  // Prefilled with the project the user is already in, rather than making them
  // pick a workspace they have just chosen in the header. The picker still lets
  // them write into a different one, and re-tapping the row clears the choice.
  const [workspacePath, setWorkspacePath] = useState<string | null>(defaultWorkspacePath);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<MobileControlBacklogItemType | undefined>(undefined);
  const [difficulty, setDifficulty] = useState<MobileControlBacklogItemDifficulty | undefined>(undefined);
  const [criticality, setCriticality] = useState<MobileControlBacklogItemCriticality | undefined>(undefined);
  const [formState, setFormState] = useState<CreateFormState>({ status: "editing", error: null });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.workspacePath === workspacePath) ?? null,
    [workspaces, workspacePath],
  );

  // Capability-denied: the desktop does not advertise backlog.create for this
  // device, or this pairing's grant does not cover it. A grant is frozen at pair
  // time, so re-pairing is how it widens.
  if (onCreate === null) {
    return (
      <View style={createFormStyles.panel}>
        <Text style={createFormStyles.panelTitle}>New backlog item</Text>
        <View style={[createFormStyles.message, createFormStyles.errorMessage]}>
          <Text style={createFormStyles.messageText}>
            Creating backlog items isn’t available from this device yet. Re-pair this phone with your desktop to enable
            it.
          </Text>
        </View>
        <PrimaryButton label="Close" onPress={onClose} variant="secondary" />
      </View>
    );
  }

  // "Create another" lands back on the same project, not on an empty picker.
  const resetDraft = () => {
    setWorkspacePath(defaultWorkspacePath);
    setTitle("");
    setDescription("");
    setType(undefined);
    setDifficulty(undefined);
    setCriticality(undefined);
  };

  const handleReview = () => {
    const validation = buildBacklogCreatePayload({ workspacePath, title, description, type, difficulty, criticality });
    if (!validation.ok) {
      setFormState({ status: "editing", error: validation.error });
      return;
    }
    setFormState({ status: "confirming" });
  };

  const handleConfirm = async () => {
    const validation = buildBacklogCreatePayload({ workspacePath, title, description, type, difficulty, criticality });
    if (!validation.ok) {
      setFormState({ status: "editing", error: validation.error });
      return;
    }

    setFormState({ status: "pending" });
    try {
      const result = await onCreate(validation.payload);
      const where = selectedWorkspace ? ` in ${selectedWorkspace.workspaceName}` : "";
      setFormState({
        status: "success",
        message: result.relativePath
          ? `Created ${result.relativePath}${where}. It appears in the list on refresh.`
          : `Backlog item created${where}. It appears in the list on refresh.`,
      });
    } catch (error) {
      setFormState({
        status: "error",
        message: error instanceof Error ? error.message : "Desktop rejected the backlog item.",
      });
    }
  };

  if (formState.status === "success") {
    return (
      <View style={createFormStyles.panel}>
        <Text style={createFormStyles.panelTitle}>New backlog item</Text>
        <View style={[createFormStyles.message, createFormStyles.successMessage]}>
          <Text style={createFormStyles.messageText}>{formState.message}</Text>
        </View>
        <PrimaryButton
          label="Create another"
          onPress={() => {
            resetDraft();
            setFormState({ status: "editing", error: null });
          }}
        />
        <PrimaryButton label="Done" onPress={onClose} variant="secondary" />
      </View>
    );
  }

  const pending = formState.status === "pending";
  // Keep the confirm panel mounted through the send so the user sees the
  // "Creating…" state instead of the form flashing back.
  const confirming = formState.status === "confirming" || pending;

  return (
    <View style={createFormStyles.panel}>
      <Text style={createFormStyles.panelTitle}>New backlog item</Text>

      {confirming ? (
        <View style={createFormStyles.confirmPanel}>
          <Text style={createFormStyles.confirmTitle}>Create this backlog item?</Text>
          <Text style={createFormStyles.confirmBody}>
            This writes a new item to {selectedWorkspace?.workspaceName ?? "the chosen workspace"} on your desktop.
          </Text>
          <Text style={createFormStyles.summaryTitle}>{title.trim()}</Text>
          {description.trim() ? <Text style={createFormStyles.summaryBody}>{description.trim()}</Text> : null}
          <PrimaryButton
            accessibilityLabel="Confirm create backlog item"
            disabled={pending}
            label={pending ? "Creating…" : "Confirm create"}
            onPress={handleConfirm}
          />
          <PrimaryButton
            disabled={pending}
            label="Back"
            onPress={() => setFormState({ status: "editing", error: null })}
            variant="secondary"
          />
        </View>
      ) : (
        <>
          <WorkspacePicker
            workspaces={workspaces}
            selectedPath={workspacePath}
            isLoading={isLoading}
            onSelect={setWorkspacePath}
          />

          <View style={createFormStyles.field}>
            <Text style={createFormStyles.fieldLabel}>Title</Text>
            <TextInput
              accessibilityLabel="Backlog item title"
              autoCapitalize="sentences"
              maxLength={backlogCreateTitleMaxChars}
              onChangeText={setTitle}
              placeholder="What needs doing?"
              placeholderTextColor={colors.textSubtle}
              style={createFormStyles.input}
              value={title}
            />
          </View>

          <View style={createFormStyles.field}>
            <Text style={createFormStyles.fieldLabel}>Description</Text>
            <TextInput
              accessibilityLabel="Backlog item description"
              autoCapitalize="sentences"
              maxLength={backlogCreateDescriptionMaxChars}
              multiline
              onChangeText={setDescription}
              placeholder="Optional detail: behaviour, intent, repro notes"
              placeholderTextColor={colors.textSubtle}
              style={[createFormStyles.input, createFormStyles.multilineInput]}
              textAlignVertical="top"
              value={description}
            />
          </View>

          {/* Re-tapping the selected chip clears the axis: an absent field on
              create means "let the desktop decide", which is a real choice here. */}
          <OptionRow
            label="Type"
            options={backlogCreateTypeOptions}
            selected={type}
            format={capitalizeToken}
            onSelect={(next) => setType(next === type ? undefined : next)}
          />
          <OptionRow
            label="Difficulty"
            options={backlogCreateDifficultyOptions}
            selected={difficulty}
            format={(value) => value.toUpperCase()}
            onSelect={(next) => setDifficulty(next === difficulty ? undefined : next)}
          />
          <OptionRow
            label="Criticality"
            options={backlogCreateCriticalityOptions}
            selected={criticality}
            format={capitalizeToken}
            onSelect={(next) => setCriticality(next === criticality ? undefined : next)}
          />

          {formState.status === "editing" && formState.error ? (
            <View accessibilityRole="alert" style={[createFormStyles.message, createFormStyles.errorMessage]}>
              <Text style={createFormStyles.messageText}>{formState.error}</Text>
            </View>
          ) : null}

          <PrimaryButton
            accessibilityLabel="Review new backlog item before creating"
            label="Create item"
            onPress={handleReview}
          />
          <PrimaryButton label="Cancel" onPress={onClose} variant="secondary" />
        </>
      )}

      {formState.status === "error" ? (
        <View accessibilityRole="alert" style={[createFormStyles.message, createFormStyles.errorMessage]}>
          <Text style={createFormStyles.messageText}>{formState.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

