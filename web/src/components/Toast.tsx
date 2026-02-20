import { useEffect, useState, useCallback } from "react";

type ToastType = "success" | "error";

let showToastFn: (msg: string, type: ToastType) => void = () => {};

export function toast(msg: string, type: ToastType = "success") {
  showToastFn(msg, type);
}

export default function Toast() {
  const [message, setMessage] = useState("");
  const [type, setType] = useState<ToastType>("success");
  const [visible, setVisible] = useState(false);

  const show = useCallback((msg: string, t: ToastType) => {
    setMessage(msg);
    setType(t);
    setVisible(true);
    setTimeout(() => setVisible(false), 3000);
  }, []);

  useEffect(() => {
    showToastFn = show;
    return () => {
      showToastFn = () => {};
    };
  }, [show]);

  return (
    <div className={`toast toast-${type}${visible ? " show" : ""}`}>
      {message}
    </div>
  );
}
