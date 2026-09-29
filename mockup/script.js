const dialog = document.querySelector("#review-dialog");
const reviewForm = document.querySelector("#review-form");
const reviewComment = document.querySelector("#review-comment");
const toolDialog = document.querySelector("#tool-approval-dialog");
const toolApprovalForm = document.querySelector("#tool-approval-form");
const toolApprovalComment = document.querySelector("#tool-approval-comment");
const toolApprovalBanner = document.querySelector("#tool-approval-banner");
const agentInputDialog = document.querySelector("#agent-input-dialog");
const agentInputForm = document.querySelector("#agent-input-form");
const agentInputBanner = document.querySelector("#agent-input-banner");
const customAnswerChoice = document.querySelector("#custom-answer-choice");
const customAgentAnswer = document.querySelector("#custom-agent-answer");
const toast = document.querySelector("#toast");
const caseName = document.querySelector("#case-name");
const caseReference = document.querySelector("#case-reference");
const caseStatus = document.querySelector("#case-status");
const reviewTitle = document.querySelector("#review-title");
const primaryReviewButton = document.querySelector("#open-review");
const planActionLabel = document.querySelector("#plan-action-label");
const planStepTitle = document.querySelector("#plan-step-title");
const planStepDetail = document.querySelector("#plan-step-detail");
const activeAgentName = document.querySelector("#active-agent-name");
const activeAgentAction = document.querySelector("#active-agent-action");
const activeAgentStatus = document.querySelector("#active-agent-status");
const activeAgentPill = document.querySelector("#active-agent-pill");
const overviewActiveAgent = document.querySelector("#overview-active-agent");
const overviewDependentAgent = document.querySelector("#overview-dependent-agent");
const overviewAgentEmpty = document.querySelector("#overview-agent-empty");
const dependentAgentName = document.querySelector("#dependent-agent-name");
const dependentAgentAction = document.querySelector("#dependent-agent-action");
const dependentAgentStatus = document.querySelector("#dependent-agent-status");
const toolAgentTask = document.querySelector("#tool-agent-task");
const toolAgentTaskDetail = document.querySelector("#tool-agent-task-detail");
const toolAgentTaskPill = document.querySelector("#tool-agent-task-pill");
const toolAgentCurrent = document.querySelector("#tool-agent-current");
const toolAgentWaiting = document.querySelector("#tool-agent-waiting");
const toolAgentNext = document.querySelector("#tool-agent-next");
const reviewAgentTaskDetail = document.querySelector("#review-agent-task-detail");
const reviewAgentTaskPill = document.querySelector("#review-agent-task-pill");
const reviewAgentWaiting = document.querySelector("#review-agent-waiting");
const clarificationAgentTask = document.querySelector("#clarification-agent-task");
const clarificationAgentTaskDetail = document.querySelector("#clarification-agent-task-detail");
const clarificationAgentTaskPill = document.querySelector("#clarification-agent-task-pill");
const clarificationAgentCurrent = document.querySelector("#clarification-agent-current");
const clarificationAgentWaiting = document.querySelector("#clarification-agent-waiting");
const clarificationAgentNext = document.querySelector("#clarification-agent-next");
const ownershipAgentCompleted = document.querySelector("#ownership-agent-completed");

let toastTimeout;
let toolRequestPending = false;
let inputRequestPending = false;
let currentActionMode = "case";
let progressMessage = "Agent work is in progress.";

function showToast(message) {
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function openReview() {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    window.setTimeout(() => reviewComment.focus(), 0);
  }
}

function openToolApproval() {
  if (typeof toolDialog.showModal === "function") {
    toolDialog.showModal();
    window.setTimeout(() => toolApprovalComment.focus(), 0);
  }
}

function openAgentInput() {
  if (typeof agentInputDialog.showModal === "function") {
    agentInputDialog.showModal();
    window.setTimeout(() => agentInputForm.querySelector("input[type='radio']").focus(), 0);
  }
}

function openCurrentAction() {
  if (currentActionMode === "tool") {
    openToolApproval();
  } else if (currentActionMode === "input") {
    openAgentInput();
  } else if (currentActionMode === "progress") {
    showToast(progressMessage);
  } else {
    openReview();
  }
}

function setStatus(label, statusClass) {
  caseStatus.lastChild.textContent = label;
  caseStatus.querySelector("span").className = statusClass;
}

function setAgentPill(element, label, state) {
  element.textContent = label;
  element.className = `agent-status-pill ${state}`;
}

function showOverviewAgent({ name, action, detail, pill, state }) {
  overviewActiveAgent.hidden = false;
  overviewAgentEmpty.hidden = true;
  activeAgentName.textContent = name;
  activeAgentAction.textContent = action;
  activeAgentStatus.textContent = detail;
  setAgentPill(activeAgentPill, pill, state);
}

function updateAgentViews(status) {
  toolAgentTask.hidden = status !== "Approval needed";
  clarificationAgentTask.hidden = status !== "Input needed";
  ownershipAgentCompleted.hidden = status === "Input needed";
  overviewDependentAgent.hidden = true;

  if (status === "Input needed") {
    clarificationAgentTask.className = "agent-task needs-attention";
    showOverviewAgent({
      name: "Ownership specialist",
      action: "Conflicting ownership records",
      detail: "Waiting for analyst answer",
      pill: "Needs input",
      state: "needs-input",
    });
    overviewDependentAgent.hidden = false;
    dependentAgentName.textContent = "Review coordinator";
    dependentAgentAction.textContent = "Compile case decision";
    dependentAgentStatus.textContent = "Waiting for Ownership specialist";
    clarificationAgentTaskDetail.textContent = "Conflicting ownership records need your answer";
    clarificationAgentCurrent.textContent = "Nothing until your answer";
    clarificationAgentWaiting.textContent = "Analyst answer";
    clarificationAgentNext.textContent = "Resume beneficial-owner checks";
    setAgentPill(clarificationAgentTaskPill, "Needs input", "needs-input");
    reviewAgentTaskDetail.textContent = "Waiting for Ownership specialist";
    reviewAgentWaiting.textContent = "Ownership specialist";
    setAgentPill(reviewAgentTaskPill, "Waiting", "waiting");
    return;
  }

  if (status === "Approval needed") {
    toolAgentTask.className = "agent-task needs-attention";
    showOverviewAgent({
      name: "Public research agent",
      action: "External search needs approval",
      detail: "Waiting for analyst",
      pill: "Needs approval",
      state: "needs-input",
    });
    overviewDependentAgent.hidden = false;
    dependentAgentName.textContent = "Review coordinator";
    dependentAgentAction.textContent = "Compile case decision";
    dependentAgentStatus.textContent = "Waiting for Public research agent";
    reviewAgentTaskDetail.textContent = "Waiting for Public research agent";
    reviewAgentWaiting.textContent = "Public research agent";
    setAgentPill(reviewAgentTaskPill, "Waiting", "waiting");
    toolAgentTaskDetail.textContent = "External search needs your approval";
    toolAgentCurrent.textContent = "Nothing until approval";
    toolAgentWaiting.textContent = "Analyst decision";
    toolAgentNext.textContent = "Submit the approved query";
    setAgentPill(toolAgentTaskPill, "Needs approval", "needs-input");
    return;
  }

  if (status === "Processing") {
    showOverviewAgent({
      name: "Ownership specialist",
      action: "Screening beneficial owners",
      detail: "Working · step 2 of 4",
      pill: "Working",
      state: "working",
    });
    reviewAgentTaskDetail.textContent = "Waiting for specialist findings";
    reviewAgentWaiting.textContent = "Ownership and policy specialists";
    setAgentPill(reviewAgentTaskPill, "Waiting", "waiting");
    return;
  }

  if (status === "Completed") {
    overviewActiveAgent.hidden = true;
    overviewAgentEmpty.hidden = false;
    reviewAgentTaskDetail.textContent = "Case workflow finished";
    reviewAgentWaiting.textContent = "Nothing";
    setAgentPill(reviewAgentTaskPill, "Completed", "completed");
    return;
  }

  showOverviewAgent({
    name: "Review coordinator",
    action: "Analyst decision required",
    detail: "Waiting for analyst",
    pill: "Needs input",
    state: "needs-input",
  });
  reviewAgentTaskDetail.textContent = "Analyst decision required";
  reviewAgentWaiting.textContent = "Analyst decision";
  setAgentPill(reviewAgentTaskPill, "Needs input", "needs-input");
}

primaryReviewButton.addEventListener("click", openCurrentAction);
document.querySelector("#open-review-secondary").addEventListener("click", openCurrentAction);
document.querySelector("#open-tool-approval-inline").addEventListener("click", openToolApproval);
document.querySelector("#open-agent-input-inline").addEventListener("click", openAgentInput);
customAgentAnswer.addEventListener("focus", () => {
  customAnswerChoice.checked = true;
});
customAgentAnswer.addEventListener("input", () => {
  customAgentAnswer.setCustomValidity("");
});

document.querySelector("#new-case-button").addEventListener("click", () => {
  showToast("New case flow would open here.");
});

document.querySelectorAll(".case-row").forEach((row) => {
  row.addEventListener("click", () => {
    document.querySelectorAll(".case-row").forEach((item) => item.classList.remove("selected"));
    row.classList.add("selected");
    caseName.textContent = row.dataset.case;
    caseReference.textContent = row.dataset.reference;
    setStatus(row.dataset.status, `status-${
      row.dataset.status === "Approval needed"
        ? "approval"
        : row.dataset.status === "Input needed"
          ? "input"
        : row.dataset.status === "Processing"
          ? "processing"
          : "review"
    }`);
    reviewTitle.textContent = `Approve ${row.dataset.case}?`;
    toolRequestPending = row.dataset.status === "Approval needed";
    inputRequestPending = row.dataset.status === "Input needed";
    currentActionMode = toolRequestPending ? "tool" : inputRequestPending ? "input" : "case";
    toolApprovalBanner.hidden = !toolRequestPending;
    agentInputBanner.hidden = !inputRequestPending;
    primaryReviewButton.textContent = toolRequestPending ? "Review tool request" : inputRequestPending ? "Answer agent" : "Review decision";
    planActionLabel.textContent = toolRequestPending ? "Review tool request" : inputRequestPending ? "Answer agent" : "Continue review";
    planStepTitle.textContent = toolRequestPending ? "Approve external search" : inputRequestPending ? "Provide agent input" : "Analyst decision";
    planStepDetail.textContent = toolRequestPending ? "Waiting for your decision" : inputRequestPending ? "Waiting for your answer" : "Waiting for your review";
    updateAgentViews(row.dataset.status);
    showToast(`${row.dataset.case} selected.`);
  });
});

const tabs = [...document.querySelectorAll("[role='tab']")];

tabs.forEach((tab, tabIndex) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[role='tab']").forEach((item) => item.setAttribute("aria-selected", "false"));
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = true;
      panel.classList.remove("active");
    });

    tab.setAttribute("aria-selected", "true");
    const panel = document.querySelector(`#${tab.dataset.tab}`);
    panel.hidden = false;
    panel.classList.add("active");
  });

  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (tabIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  });
});

document.querySelector("#view-agent-activity").addEventListener("click", () => {
  const activityTab = document.querySelector("#activity-tab");
  activityTab.click();
  activityTab.focus();
});

reviewForm.addEventListener("submit", (event) => {
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return;

  if (!reviewComment.checkValidity()) {
    event.preventDefault();
    reviewComment.reportValidity();
    return;
  }

  event.preventDefault();
  dialog.close();
  showToast(submitter?.value === "changes" ? "Changes requested and added to the audit trail." : "Case approved and added to the audit trail.");
  reviewForm.reset();
});

dialog.addEventListener("click", (event) => {
  const bounds = dialog.getBoundingClientRect();
  const clickedBackdrop =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (clickedBackdrop) dialog.close();
});

toolApprovalForm.addEventListener("submit", (event) => {
  const decision = event.submitter?.value;
  if (decision === "cancel") return;
  if (!toolApprovalComment.checkValidity()) {
    event.preventDefault();
    toolApprovalComment.reportValidity();
    return;
  }

  event.preventDefault();
  toolDialog.close();
  toolRequestPending = false;
  toolApprovalBanner.hidden = true;
  toolApprovalForm.reset();

  if (decision === "approved") {
    currentActionMode = "progress";
    progressMessage = "The public research agent is working on the approved search.";
    setStatus("Processing", "status-processing");
    primaryReviewButton.textContent = "View progress";
    planActionLabel.textContent = "View search progress";
    planStepTitle.textContent = "Run external search";
    planStepDetail.textContent = "Searching approved public sources";
    toolAgentTask.hidden = false;
    toolAgentTask.className = "agent-task";
    showOverviewAgent({ name: "Public research agent", action: "Searching approved regulator sites", detail: "Working · 0 of 5 sources", pill: "Working", state: "working" });
    overviewDependentAgent.hidden = false;
    toolAgentTaskDetail.textContent = "Searching approved regulator sites";
    toolAgentCurrent.textContent = "Reading approved public sources";
    toolAgentWaiting.textContent = "Nothing";
    toolAgentNext.textContent = "Store sources as external evidence";
    setAgentPill(toolAgentTaskPill, "Working", "working");
    showToast("Search approved. The public research agent is now working.");
    return;
  }

  if (decision === "changes") {
    currentActionMode = "progress";
    progressMessage = "The public research agent is revising the search request.";
    setStatus("Processing", "status-processing");
    primaryReviewButton.textContent = "View progress";
    planActionLabel.textContent = "View requested changes";
    planStepTitle.textContent = "Revise external search";
    planStepDetail.textContent = "Agent is updating the requested scope";
    toolAgentTask.hidden = false;
    toolAgentTask.className = "agent-task";
    showOverviewAgent({ name: "Public research agent", action: "Revising external search", detail: "Applying requested scope changes", pill: "Working", state: "working" });
    overviewDependentAgent.hidden = false;
    toolAgentTaskDetail.textContent = "Revising the requested search";
    toolAgentCurrent.textContent = "Applying the analyst comment";
    toolAgentWaiting.textContent = "Nothing";
    toolAgentNext.textContent = "Submit a revised approval request";
    setAgentPill(toolAgentTaskPill, "Working", "working");
    showToast("Changes requested and added to the audit trail.");
    return;
  }

  setStatus("Ready for review", "status-review");
  currentActionMode = "case";
  primaryReviewButton.textContent = "Review decision";
  planActionLabel.textContent = "Continue review";
  planStepTitle.textContent = "Analyst decision";
  planStepDetail.textContent = "External search was rejected";
  toolAgentTask.hidden = false;
  toolAgentTask.className = "agent-task";
  showOverviewAgent({ name: "Review coordinator", action: "Analyst decision required", detail: "External search rejected", pill: "Needs input", state: "needs-input" });
  overviewDependentAgent.hidden = true;
  toolAgentTaskDetail.textContent = "External search rejected by analyst";
  toolAgentCurrent.textContent = "Nothing";
  toolAgentWaiting.textContent = "Nothing";
  toolAgentNext.textContent = "No external search will run";
  setAgentPill(toolAgentTaskPill, "Rejected", "rejected");
  reviewAgentTaskDetail.textContent = "Analyst decision required";
  reviewAgentWaiting.textContent = "Analyst decision";
  setAgentPill(reviewAgentTaskPill, "Needs input", "needs-input");
  showToast("Search rejected and added to the audit trail.");
});

toolDialog.addEventListener("click", (event) => {
  const bounds = toolDialog.getBoundingClientRect();
  const clickedBackdrop =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (clickedBackdrop) toolDialog.close();
});

agentInputForm.addEventListener("submit", (event) => {
  const decision = event.submitter?.value;
  if (decision === "cancel") return;
  if (decision === "skip") {
    showToast("Question skipped for now. The ownership specialist is still waiting.");
    return;
  }

  event.preventDefault();
  const answer = new FormData(agentInputForm).get("ownership-record");
  if (answer === "custom" && !customAgentAnswer.value.trim()) {
    customAgentAnswer.setCustomValidity("Enter the answer you want the agent to use.");
    customAgentAnswer.reportValidity();
    customAgentAnswer.focus();
    return;
  }
  const answerLabels = {
    "shareholder-register": "Shareholder register selected",
    "application-form": "Application form selected",
    "request-document": "Updated ownership document requested",
    custom: customAgentAnswer.value.trim(),
  };

  agentInputDialog.close();
  agentInputBanner.hidden = true;
  inputRequestPending = false;
  currentActionMode = "progress";
  progressMessage = "The ownership specialist is applying your answer.";
  setStatus("Processing", "status-processing");
  primaryReviewButton.textContent = "View progress";
  planActionLabel.textContent = "View agent progress";
  planStepTitle.textContent = "Resume ownership review";
  planStepDetail.textContent = "Applying your answer to the remaining checks";

  clarificationAgentTask.hidden = false;
  clarificationAgentTask.className = "agent-task";
  ownershipAgentCompleted.hidden = true;
  showOverviewAgent({
    name: "Ownership specialist",
    action: "Applying analyst answer",
    detail: "Working · step 3 of 4",
    pill: "Working",
    state: "working",
  });
  overviewDependentAgent.hidden = false;
  dependentAgentName.textContent = "Review coordinator";
  dependentAgentAction.textContent = "Compile case decision";
  dependentAgentStatus.textContent = "Waiting for Ownership specialist";
  clarificationAgentTaskDetail.textContent = "Applying the analyst answer";
  clarificationAgentCurrent.textContent = answerLabels[answer] ?? "Applying the selected answer";
  clarificationAgentWaiting.textContent = "Nothing";
  clarificationAgentNext.textContent = "Complete beneficial-owner checks";
  setAgentPill(clarificationAgentTaskPill, "Working", "working");
  reviewAgentTaskDetail.textContent = "Waiting for Ownership specialist";
  reviewAgentWaiting.textContent = "Ownership specialist";
  setAgentPill(reviewAgentTaskPill, "Waiting", "waiting");
  customAgentAnswer.setCustomValidity("");
  agentInputForm.reset();
  showToast("Answer sent. The ownership specialist has resumed work.");
});

agentInputDialog.addEventListener("click", (event) => {
  const bounds = agentInputDialog.getBoundingClientRect();
  const clickedBackdrop =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (clickedBackdrop) agentInputDialog.close();
});
