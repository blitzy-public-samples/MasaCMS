// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
export {
  actionButton,
  alertBox,
  block,
  controlGroup,
  detailList,
  formActions,
  GUARDED_NATIVE_SUBMIT,
  GUARDED_SUBMIT,
  gridTable,
  hiddenField,
  hiddenFields,
  pageHeader,
  postForm,
  rowActionsMenu,
  select,
  submitButton,
  textarea,
  textInput,
  valueRows,
  wrappable,
} from './markup';
export type {
  AlertKind,
  FieldError,
  FormButton,
  GridCell,
  HeaderLink,
  Label,
  RowAction,
  SelectOption,
  ValueRow,
} from './markup';
export { bundleLabel, opt2Label, OPT2_LABEL_KEYS } from './labels';
export type { Opt2LabelName } from './labels';
export { amountCell, stateBadge, stateBadgeOf } from './states';
export type { StateDisplay, StateTone } from './states';
export { noAccessUrl, opt2ActionUrl, opt2ScreenUrl } from './paths';
export type { Opt2Params } from './paths';
export { canUse, opt2Gate } from './access';
export { invalidParametersAlert, isMalformedId } from './ids';
export {
  csrfHeadersFrom,
  errorMessage,
  focusesFirst,
  INVALID_PARAMETERS,
  isInvalidParameters,
  refusedFields,
  submitToService,
} from './submit';
export type { FieldRule, Opt2Back, Opt2Refusal, Opt2Rerender, Opt2Write } from './submit';
export { OPT2_SCREEN_TITLES, opt2View } from './view';
export { pagination, readPage } from './pagination';
export type { PageState } from './pagination';
