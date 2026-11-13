// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
export {
  actionButton,
  alertBox,
  block,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  hiddenFields,
  pageHeader,
  postForm,
  select,
  textarea,
  textInput,
} from './markup';
export type { AlertKind, FormButton, GridCell, HeaderLink, SelectOption } from './markup';
export { noAccessUrl, opt2ActionUrl, opt2ScreenUrl } from './paths';
export type { Opt2Params } from './paths';
export { canUse, opt2Gate } from './access';
export { csrfHeadersFrom, errorMessage, submitToService } from './submit';
export type { Opt2Back, Opt2Write } from './submit';
export { opt2View } from './view';
