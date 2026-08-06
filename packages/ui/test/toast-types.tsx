import { Button, Toast, type ToastProps } from '../src/index';

export const toastWithAction = (
  <Toast action={<Button>Undo</Button>} actionAltText="Undo the saved change" open title="Saved" />
);

// @ts-expect-error -- Toast actions require action-specific announcement text.
export const toastActionWithoutAltText: ToastProps = {
  action: <Button>Undo</Button>,
  open: true,
  title: 'Saved',
};

// @ts-expect-error -- Action alt text is invalid when no action is rendered.
export const toastAltTextWithoutAction = <Toast actionAltText="Undo" open title="Saved" />;
