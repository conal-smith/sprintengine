import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { BottomSheet } from "../../components/BottomSheet";
import { ChevronIcon, CloseIcon, iconSize, ScheduleIcon } from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useNow } from "../../components/useNow";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, hitTargetMin, radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { CRON_FIELD_NAMES, parseCronSchedule } from "../../shared/cron/cron";
import {
  cronFromEditorState,
  editorStateFromCron,
  formatScheduleTime,
  parseScheduleTime,
  switchTab,
  type ScheduleEditorState,
  type ScheduleTab,
  type ScheduleTime,
} from "./scheduleEditor";
import { nextFreeTime, readPickedSchedule, readSchedule, type PickedSchedule } from "./schedulePick";
import {
  defaultSendAt,
  minutesOfDay,
  onOrBeforeToday,
  quickSendTimes,
  sendDayWords,
  sendTimeFromNow,
  sendTimeWords,
  withDayOffset,
  withMinutesOfDay,
} from "./sendTime";

// New chat's schedule, on a phone: the desktop's picker (`SchedulePicker.tsx`)
// as a sheet. Once runs a single time; Daily, Weekly and Monthly write the
// everyday shapes of a repeat; Cron takes anything. Every change that reads is
// handed back at once, so the tag it opens from says the new schedule while
// the sheet is still up; one that does not read is kept here, marked, and the
// last schedule that did stays.

const TABS: { value: ScheduleTab | "once"; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "cron", label: "Cron" },
];

// Monday first, the way a working week is read; the values are cron's.
const WEEKDAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: "M", name: "Monday" },
  { value: 2, short: "T", name: "Tuesday" },
  { value: 3, short: "W", name: "Wednesday" },
  { value: 4, short: "T", name: "Thursday" },
  { value: 5, short: "F", name: "Friday" },
  { value: 6, short: "S", name: "Saturday" },
  { value: 0, short: "S", name: "Sunday" },
];

const FIELD_LABEL: Record<(typeof CRON_FIELD_NAMES)[number], string> = {
  minute: "min",
  hour: "hour",
  day: "day",
  month: "month",
  weekday: "weekday",
};

export function ScheduleSheet({
  visible,
  schedule,
  timezone,
  onceOffered,
  onChange,
  onClose,
}: {
  visible: boolean;
  schedule: PickedSchedule;
  timezone: string;
  /** Whether the desktop takes a one-time run (`scheduled-agents`); without it there is no Once tab. */
  onceOffered: boolean;
  onChange: (schedule: PickedSchedule) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <BottomSheet onClose={onClose} title="Schedule" visible={visible}>
      {visible ? <ScheduleEditor onChange={onChange} onceOffered={onceOffered} schedule={schedule} timezone={timezone} /> : null}
      <View style={styles.done}>
        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

function ScheduleEditor({
  schedule,
  timezone,
  onceOffered,
  onChange,
}: {
  schedule: PickedSchedule;
  timezone: string;
  onceOffered: boolean;
  onChange: (schedule: PickedSchedule) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const now = useNow(true);
  const [state, setState] = useState<ScheduleEditorState>(() => editorStateFromCron(schedule.cron));
  // The time Once picks, kept while a repeat is picked so going back finds it.
  const [onceAt, setOnceAt] = useState(() => schedule.once ?? defaultSendAt(Date.now()));
  const update = (next: ScheduleEditorState) => {
    setState(next);
    const written = cronFromEditorState(next);
    if (written && parseCronSchedule(written).ok) onChange({ cron: written, once: null });
  };
  const written = cronFromEditorState(state) ?? "";
  const read = readSchedule(written, timezone, now);
  const tab = schedule.once !== null ? "once" : state.tab;

  const tabs = (
    <View accessibilityLabel="How often" accessibilityRole="tablist" style={styles.tabs}>
      {TABS.filter((entry) => onceOffered || entry.value !== "once").map((entry) => {
        const selected = entry.value === tab;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={entry.value}
            onPress={() => {
              if (entry.value === "once") {
                onChange({ cron: schedule.cron, once: onceAt });
                return;
              }
              // Back from Once: the repeat the controls hold, on the tab picked.
              if (schedule.once !== null && entry.value === state.tab) {
                onChange({ cron: written && parseCronSchedule(written).ok ? written : schedule.cron, once: null });
                return;
              }
              if (schedule.once !== null) onChange({ cron: schedule.cron, once: null });
              update(switchTab(state, entry.value));
            }}
            style={({ pressed }) => [styles.tab, selected ? styles.tabOn : null, pressed && !selected ? styles.pressed : null]}
          >
            <Text numberOfLines={1} style={[styles.tabText, selected ? styles.tabTextOn : null]}>
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (schedule.once !== null) {
    return (
      <View style={styles.editor}>
        {tabs}
        <SendTimeEditor
          at={schedule.once}
          onChange={(at) => {
            setOnceAt(at);
            onChange({ cron: schedule.cron, once: at });
          }}
          timezone={timezone}
        />
      </View>
    );
  }

  return (
    <View style={styles.editor}>
      {tabs}

      {state.tab === "weekly" ? (
        <Section label="On">
          <View accessibilityLabel="Days of the week" style={styles.days}>
            {WEEKDAYS.map((day) => {
              const on = state.weekdays.includes(day.value);
              return (
                <DayChip
                  accessibilityLabel={day.name}
                  key={day.value}
                  label={day.short}
                  on={on}
                  onPress={() =>
                    update({
                      ...state,
                      weekdays: on ? state.weekdays.filter((value) => value !== day.value) : [...state.weekdays, day.value],
                    })
                  }
                />
              );
            })}
          </View>
        </Section>
      ) : null}

      {state.tab === "monthly" ? (
        <Section label="On day">
          <View accessibilityLabel="Days of the month" style={styles.monthDays}>
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
              const on = state.monthDays.includes(day);
              return (
                <View key={day} style={styles.monthDayCell}>
                  <DayChip
                    label={String(day)}
                    on={on}
                    onPress={() =>
                      update({
                        ...state,
                        monthDays: on ? state.monthDays.filter((value) => value !== day) : [...state.monthDays, day],
                      })
                    }
                  />
                </View>
              );
            })}
          </View>
        </Section>
      ) : null}

      {state.tab === "cron" ? (
        <CronField
          badField={read.ok ? null : (read.field ?? null)}
          onChange={(cronText) => update({ ...state, cronText })}
          text={state.cronText}
        />
      ) : (
        <Section label="At">
          <View style={styles.wrap}>
            {state.times.map((time, index) => (
              <TimeField
                key={`${index}-${time}`}
                onChange={(next) => update({ ...state, times: state.times.map((value, at) => (at === index ? next : value)) })}
                onRemove={
                  state.times.length > 1 ? () => update({ ...state, times: state.times.filter((_, at) => at !== index) }) : undefined
                }
                time={time}
              />
            ))}
            <OptionChip label="+ Time" onPress={() => update({ ...state, times: [...state.times, nextFreeTime(state.times)] })} />
          </View>
        </Section>
      )}

      <View accessibilityLabel="What this schedule does" accessibilityLiveRegion="polite" style={styles.readout}>
        {read.ok ? (
          <>
            <Text style={styles.readoutWords}>{read.words}</Text>
            <Text style={styles.readoutNext}>Next {read.next.join(" · ")}</Text>
          </>
        ) : (
          <>
            <Text style={styles.readoutError}>{read.message}</Text>
            <Text style={styles.readoutNext}>The last schedule that read stays until this one does.</Text>
          </>
        )}
      </View>

      <ZoneLine cron={state.tab !== "cron" && written ? written : null} timezone={timezone} />
    </View>
  );
}

/**
 * One moment to send at: Once's editor, and the time a message scheduled into
 * a chat goes out, as the desktop's `SendTimeEditor` is both. The everyday
 * times are one press each; any other is a day stepped to and a time typed.
 */
export function SendTimeEditor({
  at,
  onChange,
  timezone,
}: {
  at: number;
  onChange: (at: number) => void;
  /** Said under the readout where the zone matters: a scheduled agent's. */
  timezone?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const now = useNow(true);
  const passed = at <= now;
  return (
    <View style={styles.editor}>
      <View accessibilityLabel="Quick times" style={styles.wrap}>
        {quickSendTimes(now).map((choice) => (
          <OptionChip key={choice.label} label={choice.label} onPress={() => onChange(choice.at)} selected={choice.at === at} />
        ))}
      </View>
      <View style={styles.row}>
        <Section label="On">
          <View style={styles.stepper}>
            <StepButton
              direction="left"
              disabled={onOrBeforeToday(at, now)}
              label="The day before"
              onPress={() => onChange(withDayOffset(at, -1))}
            />
            <Text style={styles.stepperText}>{sendDayWords(at, now)}</Text>
            <StepButton direction="right" label="The day after" onPress={() => onChange(withDayOffset(at, 1))} />
          </View>
        </Section>
        <Section label="At">
          <TimeField onChange={(minutes) => onChange(withMinutesOfDay(at, minutes))} time={minutesOfDay(at)} />
        </Section>
      </View>
      <View accessibilityLabel="When it sends" accessibilityLiveRegion="polite" style={styles.readout}>
        {passed ? (
          <Text style={styles.readoutError}>That time has passed — pick one ahead.</Text>
        ) : (
          <>
            <Text style={styles.readoutWords}>{sendTimeWords(at, now)}</Text>
            <Text style={styles.readoutNext}>{sendTimeFromNow(at, now)}</Text>
          </>
        )}
      </View>
      {timezone ? <ZoneLine timezone={timezone} /> : null}
    </View>
  );
}

/** The send time's picker, as a sheet: a chat's "+" Schedule. */
export function SendTimeSheet({
  visible,
  at,
  onChange,
  onClose,
}: {
  visible: boolean;
  at: number;
  onChange: (at: number) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <BottomSheet onClose={onClose} title="Send at" visible={visible}>
      {visible ? <SendTimeEditor at={at} onChange={onChange} /> : null}
      <View style={styles.done}>
        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

/**
 * The time a message will be sent at, as a tag beside a chat's "+": the
 * schedule glyph, the time, and × to send it as usual instead, as the
 * desktop's `SendTimeTag`.
 */
export function SendTimeTag({ at, onPress, onRemove }: { at: number; onPress: () => void; onRemove: () => void }) {
  const now = useNow(false);
  const words = sendTimeWords(at, now);
  return (
    <TagShell
      accessibilityLabel={`Sends ${words}`}
      error={at <= now}
      onPress={onPress}
      onRemove={onRemove}
      removeLabel="Don't schedule, send as usual"
      words={words}
    />
  );
}

/** The schedule as a tag beside the composer's "+": its glyph, what it says, and × to stop scheduling. */
export function ScheduleTag({
  schedule,
  timezone,
  onPress,
  onRemove,
}: {
  schedule: PickedSchedule;
  timezone: string;
  onPress: () => void;
  onRemove: () => void;
}) {
  const now = useNow(false);
  const read = readPickedSchedule(schedule, timezone, now);
  return (
    <TagShell
      accessibilityLabel={read.ok ? `Schedule: ${read.words}, next ${read.next[0]}` : `Schedule: ${read.message}`}
      error={!read.ok}
      onPress={onPress}
      onRemove={onRemove}
      removeLabel="Stop scheduling"
      words={read.ok ? read.words : read.message}
    />
  );
}

function TagShell({
  words,
  error,
  accessibilityLabel,
  removeLabel,
  onPress,
  onRemove,
}: {
  words: string;
  error: boolean;
  accessibilityLabel: string;
  removeLabel: string;
  onPress: () => void;
  onRemove: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.tag}>
      <Pressable
        accessibilityHint="Change when it runs."
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        hitSlop={touchSlop(TAG_HEIGHT)}
        onPress={onPress}
        style={({ pressed }) => [styles.tagBody, pressed ? styles.pressed : null]}
      >
        <ScheduleIcon size={iconSize.xs} tone="accentPrimary" />
        <Text numberOfLines={1} style={[styles.tagText, error ? styles.tagTextError : null]}>
          {words}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={removeLabel}
        accessibilityRole="button"
        hitSlop={touchSlop(TAG_HEIGHT)}
        onPress={onRemove}
        style={({ pressed }) => [styles.tagRemove, pressed ? styles.pressed : null]}
      >
        <CloseIcon size={iconSize.xs - 2} tone="textSubtle" />
      </Pressable>
    </View>
  );
}

const TAG_HEIGHT = 32;

function Section({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function OptionChip({ label, selected = false, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected ? styles.chipOn : null, pressed && !selected ? styles.pressed : null]}
    >
      <Text style={[styles.chipText, selected ? styles.chipTextOn : null]}>{label}</Text>
    </Pressable>
  );
}

function DayChip({
  label,
  on,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={({ pressed }) => [styles.dayChip, on ? styles.chipOn : null, pressed && !on ? styles.pressed : null]}
    >
      <Text style={[styles.chipText, styles.tabular, on ? styles.chipTextOn : null]}>{label}</Text>
    </Pressable>
  );
}

function StepButton({
  direction,
  label,
  disabled = false,
  onPress,
}: {
  direction: "left" | "right";
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.step, disabled ? styles.disabled : null, pressed ? styles.pressed : null]}
    >
      <ChevronIcon direction={direction} size={iconSize.sm} tone="textMuted" />
    </Pressable>
  );
}

/**
 * One time of day, typed: "9", "9:30", "9pm", "21:00". Read when the keyboard
 * is done or focus leaves; one that does not read goes back to what it was. A
 * bare hour keeps the AM/PM the field already had.
 */
function TimeField({ time, onChange, onRemove }: { time: ScheduleTime; onChange: (time: ScheduleTime) => void; onRemove?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const shown = formatScheduleTime(time);
  const [text, setText] = useState(`${shown.clock} ${shown.meridiem}`);
  useEffect(() => setText(`${shown.clock} ${shown.meridiem}`), [shown.clock, shown.meridiem]);
  const commit = () => {
    const read = parseScheduleTime(text, shown.meridiem);
    if (read === null) setText(`${shown.clock} ${shown.meridiem}`);
    else if (read !== time) onChange(read);
  };
  return (
    <View style={styles.timeField}>
      <TextInput
        accessibilityLabel="Time of day"
        autoCorrect={false}
        onBlur={commit}
        onChangeText={setText}
        onSubmitEditing={commit}
        placeholderTextColor={colors.textSubtle}
        returnKeyType="done"
        selectTextOnFocus
        style={styles.timeInput}
        value={text}
      />
      {onRemove ? (
        <Pressable
          accessibilityLabel={`Remove ${shown.clock} ${shown.meridiem}`}
          accessibilityRole="button"
          hitSlop={touchSlop(TAG_HEIGHT)}
          onPress={onRemove}
          style={({ pressed }) => [styles.timeRemove, pressed ? styles.pressed : null]}
        >
          <CloseIcon size={iconSize.xs - 2} tone="textSubtle" />
        </Pressable>
      ) : null}
    </View>
  );
}

function CronField({ text, badField, onChange }: { text: string; badField: string | null; onChange: (text: string) => void }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <TextInput
        accessibilityLabel="Cron schedule"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChange}
        placeholder="0 9 * * 1-5"
        placeholderTextColor={colors.textSubtle}
        spellCheck={false}
        style={[styles.cronInput, badField ? styles.cronInputBad : null]}
        value={text}
      />
      {/* The five fields named under the line, the wrong one in the error ink —
          which part to fix, not just that something is wrong. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.cronFields}>
        {CRON_FIELD_NAMES.map((field) => (
          <Text key={field} style={[styles.cronFieldName, badField === field ? styles.readoutError : null]}>
            {FIELD_LABEL[field]}
          </Text>
        ))}
      </View>
    </View>
  );
}

function ZoneLine({ timezone, cron = null }: { timezone: string; cron?: string | null }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.zone}>
      <ScheduleIcon size={iconSize.xs} tone="textSubtle" />
      <Text numberOfLines={1} style={styles.zoneText}>
        Your time · {timezone}
      </Text>
      {cron ? <Text style={styles.zoneCron}>{cron}</Text> : null}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    editor: {
      gap: space.lg,
    },
    done: {
      paddingTop: space.lg,
    },
    tabs: {
      flexDirection: "row",
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      overflow: "hidden",
    },
    tab: {
      flex: 1,
      minHeight: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    tabOn: {
      backgroundColor: colors.bgSelected,
    },
    tabText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    tabTextOn: {
      color: colors.textPrimary,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    disabled: {
      opacity: 0.4,
    },
    section: {
      gap: space.xs,
    },
    sectionLabel: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textSubtle,
    },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.xl,
    },
    wrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.sm,
    },
    chip: {
      minHeight: 36,
      justifyContent: "center",
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      paddingHorizontal: space.lg,
    },
    chipOn: {
      borderColor: "transparent",
      backgroundColor: colors.bgSelected,
    },
    chipText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    chipTextOn: {
      color: colors.textPrimary,
    },
    tabular: {
      fontVariant: ["tabular-nums"],
    },
    days: {
      flexDirection: "row",
      gap: space.xs,
    },
    dayChip: {
      flex: 1,
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderDefault,
    },
    monthDays: {
      flexDirection: "row",
      flexWrap: "wrap",
      rowGap: space.xs,
    },
    // Seven to a row, as a calendar's week is.
    monthDayCell: {
      width: `${100 / 7}%`,
      flexDirection: "row",
      paddingHorizontal: space["3xs"],
    },
    stepper: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
    },
    step: {
      width: hitTargetMin,
      height: hitTargetMin,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
    },
    stepperText: {
      ...typography.body,
      color: colors.textPrimary,
      minWidth: 96,
      textAlign: "center",
    },
    timeField: {
      flexDirection: "row",
      alignItems: "center",
    },
    timeInput: {
      ...typography.body,
      fontVariant: ["tabular-nums"],
      minHeight: 40,
      minWidth: 96,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.md,
      color: colors.textPrimary,
    },
    timeRemove: {
      width: TAG_HEIGHT,
      height: TAG_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
    },
    cronInput: {
      ...typography.body,
      fontFamily: monoFontFamily,
      letterSpacing: 0.6,
      minHeight: hitTargetMin,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.lg,
      color: colors.textPrimary,
    },
    cronInputBad: {
      borderColor: colors.toneError,
    },
    cronFields: {
      flexDirection: "row",
      paddingHorizontal: space.lg,
    },
    cronFieldName: {
      ...typography.micro,
      flex: 1,
      color: colors.textSubtle,
    },
    readout: {
      gap: space["3xs"],
      borderRadius: radius.control,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    readoutWords: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    readoutNext: {
      ...typography.meta,
      fontVariant: ["tabular-nums"],
      color: colors.textSubtle,
    },
    readoutError: {
      ...typography.body,
      color: colors.toneError,
    },
    zone: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
    },
    zoneText: {
      ...typography.meta,
      flex: 1,
      color: colors.textSubtle,
    },
    zoneCron: {
      ...typography.micro,
      fontFamily: monoFontFamily,
      color: colors.textMuted,
      backgroundColor: colors.bgSurface,
      borderRadius: radius.control,
      paddingHorizontal: space["2xs"],
    },
    // The tag: a raised slab with the accent glyph, the words and an ×, as
    // the desktop's tag beside its "+".
    tag: {
      flexDirection: "row",
      alignItems: "center",
      height: TAG_HEIGHT,
      borderRadius: radius.chip,
      backgroundColor: colors.bgSelected,
      flexShrink: 1,
      minWidth: 0,
    },
    tagBody: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: TAG_HEIGHT,
      paddingLeft: space.sm,
      paddingRight: space["2xs"],
      borderRadius: radius.chip,
      flexShrink: 1,
      minWidth: 0,
    },
    tagText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    tagTextError: {
      color: colors.toneError,
    },
    tagRemove: {
      width: TAG_HEIGHT - 4,
      height: TAG_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.chip,
    },
  });
