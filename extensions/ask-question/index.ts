import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  Editor,
  type EditorTheme,
  type Focusable,
  type TUI,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionInput {
  id: string;
  question: string;
  options: QuestionOption[];
}

interface PendingQuestion extends QuestionInput {
  revision: number;
}

interface Answer {
  id: string;
  question: string;
  answer: string;
  source: "suggested" | "custom";
  optionIndex?: number;
}

interface AnswerMessageDetails {
  answers: Answer[];
  dismissedQuestionIds?: string[];
}

const OptionSchema = Type.Object({
  label: Type.String({ description: "Concise answer shown to the user" }),
  description: Type.Optional(Type.String({ description: "Optional explanation of this answer" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable unique identifier; reuse it when revising this question" }),
  question: Type.String({ description: "Question shown to the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 3,
    maxItems: 3,
    description: "Exactly three useful suggested answers",
  }),
});

const AskQuestionParams = Type.Object({
  action: StringEnum(["add", "replace", "close"] as const, {
    description: "Add questions, replace the pending set, or close questions",
  }),
  questions: Type.Optional(Type.Array(QuestionSchema, { description: "Questions to add or use as the replacement set" })),
  questionIds: Type.Optional(Type.Array(Type.String(), { description: "Question IDs to close; omit to close all" })),
});

function answerText(details: AnswerMessageDetails): string {
  const lines = details.answers.map((answer) => {
    const source = answer.source === "custom" ? "user wrote" : `selected option ${answer.optionIndex}`;
    return `- ${answer.id}: ${source}: ${answer.answer}\n  Question: ${answer.question}`;
  });
  if (details.dismissedQuestionIds?.length) {
    lines.push(`- User dismissed unanswered questions: ${details.dismissedQuestionIds.join(", ")}`);
  }
  return `Questionnaire update from the user:\n${lines.join("\n")}`;
}

class QuestionOverlay implements Focusable {
  private selectedQuestion = 0;
  private selectedOption = 0;
  private editMode = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly editor: Editor;
  private _focused = false;

  constructor(
    private readonly theme: Theme,
    tui: TUI,
    private readonly getQuestions: () => PendingQuestion[],
    private readonly onAnswer: (answer: Answer) => void,
    private readonly onDismiss: () => void,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => {
      const question = this.currentQuestion();
      const answer = value.trim();
      if (!question || !answer) return;
      this.editor.setText("");
      this.editMode = false;
      this.onAnswer({ id: question.id, question: question.question, answer, source: "custom" });
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.editMode;
  }

  private currentQuestion(): PendingQuestion | undefined {
    const questions = this.getQuestions();
    if (this.selectedQuestion >= questions.length) this.selectedQuestion = Math.max(0, questions.length - 1);
    return questions[this.selectedQuestion];
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  questionsChanged(): void {
    this.currentQuestion();
    this.selectedOption = 0;
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.editMode) {
      if (matchesKey(data, Key.escape)) {
        this.editMode = false;
        this.editor.focused = false;
        this.editor.setText("");
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    const questions = this.getQuestions();
    const question = this.currentQuestion();
    if (!question) return;

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.selectedQuestion = (this.selectedQuestion + 1) % questions.length;
      this.selectedOption = 0;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.selectedQuestion = (this.selectedQuestion - 1 + questions.length) % questions.length;
      this.selectedOption = 0;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedOption = Math.max(0, this.selectedOption - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedOption = Math.min(3, this.selectedOption + 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selectedOption === 3) {
        this.editMode = true;
        this.editor.focused = this.focused;
        this.refresh();
        return;
      }
      const option = question.options[this.selectedOption];
      if (option) {
        this.onAnswer({
          id: question.id,
          question: question.question,
          answer: option.label,
          source: "suggested",
          optionIndex: this.selectedOption + 1,
        });
      }
      return;
    }
    if (matchesKey(data, Key.escape)) this.onDismiss();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const renderWidth = Math.max(1, width);
    const questions = this.getQuestions();
    const question = this.currentQuestion();
    const lines: string[] = [];

    const addWrapped = (prefix: string, text: string) => {
      const prefixWidth = visibleWidth(prefix);
      const available = Math.max(1, renderWidth - prefixWidth);
      const wrapped = wrapTextWithAnsi(text, available);
      wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`));
    };

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    addWrapped(" ", this.theme.fg("accent", this.theme.bold(`Questions (${questions.length} pending)`)));
    if (questions.length > 1) {
      const tabs = questions.map((item, index) => {
        const label = ` ${index + 1}:${item.id} `;
        return index === this.selectedQuestion
          ? this.theme.bg("selectedBg", this.theme.fg("text", label))
          : this.theme.fg("muted", label);
      });
      addWrapped(" ", tabs.join(" "));
    }
    lines.push("");

    if (question) {
      addWrapped(" ", this.theme.fg("text", this.theme.bold(question.question)));
      lines.push("");
      const choices = [...question.options, { label: "Type your own answer…" }];
      choices.forEach((option, index) => {
        const selected = index === this.selectedOption;
        const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
        addWrapped(prefix, this.theme.fg(selected ? "accent" : "text", `${index + 1}. ${option.label}`));
        if (option.description) addWrapped("     ", this.theme.fg("muted", option.description));
      });
    }

    if (this.editMode) {
      lines.push("");
      addWrapped(" ", this.theme.fg("muted", "Your answer:"));
      for (const line of this.editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
    }

    lines.push("");
    addWrapped(
      " ",
      this.theme.fg(
        "dim",
        this.editMode
          ? "Enter submit • Esc return to choices"
          : "←→/Tab questions • ↑↓ choices • Enter answer • Esc done answering",
      ),
    );
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
    this.refresh();
  }
}

export default function askQuestion(pi: ExtensionAPI) {
  const pending = new Map<string, PendingQuestion>();
  let revision = 0;
  let overlay: QuestionOverlay | undefined;
  let overlayDone: (() => void) | undefined;
  let overlayPromise: Promise<void> | undefined;
  let requestRender: (() => void) | undefined;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  let answerBuffer: Answer[] = [];

  function notifyChanged() {
    overlay?.questionsChanged();
    requestRender?.();
  }

  function closeOverlay() {
    overlayDone?.();
    overlayDone = undefined;
    overlay = undefined;
    requestRender = undefined;
  }

  function flushAnswers() {
    answerTimer = undefined;
    if (!answerBuffer.length) return;
    const answers = answerBuffer;
    answerBuffer = [];
    void pi.sendMessage(
      {
        customType: "ask-question-answer",
        content: answerText({ answers }),
        display: true,
        details: { answers } satisfies AnswerMessageDetails,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  function recordAnswer(answer: Answer) {
    if (!pending.delete(answer.id)) return;
    answerBuffer.push(answer);
    if (answerTimer) clearTimeout(answerTimer);
    answerTimer = setTimeout(flushAnswers, 200);
    if (pending.size === 0) closeOverlay();
    else notifyChanged();
  }

  function dismissAll() {
    const dismissedQuestionIds = [...pending.keys()];
    pending.clear();
    closeOverlay();
    if (!dismissedQuestionIds.length) return;
    void pi.sendMessage(
      {
        customType: "ask-question-answer",
        content: answerText({ answers: [], dismissedQuestionIds }),
        display: true,
        details: { answers: [], dismissedQuestionIds } satisfies AnswerMessageDetails,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  function ensureOverlay(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || pending.size === 0 || overlayPromise) return;
    overlayPromise = ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          overlayDone = done;
          requestRender = () => tui.requestRender();
          overlay = new QuestionOverlay(theme, tui, () => [...pending.values()], recordAnswer, dismissAll);
          return {
            get focused() {
              return overlay?.focused ?? false;
            },
            set focused(value: boolean) {
              if (overlay) overlay.focused = value;
            },
            render: (width) => overlay?.render(width) ?? [],
            invalidate: () => overlay?.invalidate(),
            handleInput: (data) => {
              overlay?.handleInput(data);
              tui.requestRender();
            },
          } as QuestionOverlay;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "72%", minWidth: 44, maxHeight: "80%", margin: 1 },
        },
      )
      .then(() => undefined)
      .finally(() => {
        overlayPromise = undefined;
        overlay = undefined;
        overlayDone = undefined;
        requestRender = undefined;
        if (pending.size > 0) ensureOverlay(ctx);
      });
  }

  pi.registerMessageRenderer("ask-question-answer", (message, _options, theme) => {
    const details = message.details as AnswerMessageDetails | undefined;
    if (!details) return new Text(typeof message.content === "string" ? message.content : "", 0, 0);
    const lines = details.answers.map((answer) => {
      const suffix = answer.source === "custom" ? theme.fg("muted", " (wrote)") : "";
      return `${theme.fg("success", "✓")} ${theme.fg("accent", answer.id)}: ${answer.answer}${suffix}`;
    });
    if (details.dismissedQuestionIds?.length) {
      lines.push(theme.fg("warning", `Dismissed: ${details.dismissedQuestionIds.join(", ")}`));
    }
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.registerTool({
    name: "ask_question",
    label: "Ask Question",
    description:
      "Manage a live, non-blocking queue of questions for the user. Each question must offer exactly three generated answers; the UI also allows a custom answer. You may add several questions at once, revise the pending queue as answers arrive, or close questions that are no longer needed. Answers arrive later as questionnaire update messages.",
    promptSnippet: "Ask one or more adaptive questions with three suggested answers each",
    promptGuidelines: [
      "Use ask_question to add multiple clarification questions when useful; every question must have exactly three distinct suggested answers.",
      "Treat ask_question as asynchronous: it queues questions and returns immediately, while answers arrive in later questionnaire update messages.",
      "Use stable question IDs, replace questions when prior answers change what should be asked, and close stale questions once enough information is available.",
    ],
    parameters: AskQuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "ask_question requires interactive TUI mode" }],
          details: { action: params.action, pending: pending.size, unavailable: true },
        };
      }

      if (params.action === "add" || params.action === "replace") {
        const questions = params.questions ?? [];
        if (params.action === "replace") pending.clear();
        for (const question of questions) {
          pending.set(question.id, { ...question, options: [...question.options], revision: ++revision });
        }
      } else {
        const ids = params.questionIds;
        if (ids?.length) ids.forEach((id) => pending.delete(id));
        else pending.clear();
      }

      if (pending.size === 0) closeOverlay();
      else {
        ensureOverlay(ctx);
        notifyChanged();
      }

      const pendingIds = [...pending.keys()];
      return {
        content: [
          {
            type: "text",
            text:
              pendingIds.length > 0
                ? `Question queue updated. Pending: ${pendingIds.join(", ")}. Answers will arrive asynchronously.`
                : "Question queue is now empty.",
          },
        ],
        details: { action: params.action, pendingIds },
      };
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ask_question"))} ${theme.fg("muted", args.action)}${count ? ` ${count}` : ""}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as { pendingIds?: string[]; unavailable?: boolean } | undefined;
      if (details?.unavailable) return new Text(theme.fg("error", "Interactive TUI unavailable"), 0, 0);
      const ids = details?.pendingIds ?? [];
      return new Text(
        ids.length ? theme.fg("success", `Queued: ${ids.join(", ")}`) : theme.fg("muted", "Question queue empty"),
        0,
        0,
      );
    },
  });

  pi.on("session_shutdown", () => {
    if (answerTimer) clearTimeout(answerTimer);
    answerTimer = undefined;
    answerBuffer = [];
    pending.clear();
    closeOverlay();
  });
}
