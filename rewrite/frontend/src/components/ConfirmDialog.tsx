import { Modal } from './Modal'

/** "¿Estás seguro...?" — same Modal chrome as everything else in the GM
 * view, so a destructive confirmation looks like part of the page
 * instead of a browser-native confirm() popup. */
export function ConfirmDialog({
  title, message, onConfirm, onCancel,
}: {
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-dialog-message">{message}</p>
      <div className="row">
        <button className="danger" onClick={onConfirm}>Confirmar</button>
        <button onClick={onCancel}>Cancelar</button>
      </div>
    </Modal>
  )
}
