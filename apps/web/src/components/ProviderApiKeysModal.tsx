import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { CheckCircle, XCircle, Plus, Trash2, Key, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Badge } from "./ui/badge";
import { toast } from "sonner";

interface ProviderApiKeysModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: any;
  onUpdate: () => void;
}

export function ProviderApiKeysModal({ open, onOpenChange, provider, onUpdate }: ProviderApiKeysModalProps) {
  const { t } = useTranslation();
  const { formatDateTime } = useSettings();
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open && provider) {
      fetchKeys();
    }
  }, [open, provider]);

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/providers/${provider.id}/keys?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        setKeys(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleAddKey = async () => {
    if (!newKey.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/providers/${provider.id}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: newKey.trim() }),
      });
      if (res.ok) {
        setNewKey("");
        await fetchKeys();
        onUpdate();
        toast.success(t("providers.apiKeys.toasts.addSuccess", "添加密钥成功"));
      } else {
        const data = await res.json();
        toast.error(data.error || t("providers.apiKeys.toasts.addFailed", "添加密钥失败"));
      }
    } catch (e: any) {
      toast.error(e.message || t("providers.apiKeys.toasts.requestFailed", "请求失败"));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    try {
      const res = await fetch(`/api/admin/providers/${provider.id}/keys/${keyId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await fetchKeys();
        onUpdate();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleStatus = async (keyId: string, currentStatus: string) => {
    try {
      const newStatus = currentStatus === 'active' ? 'exhausted' : 'active';
      const res = await fetch(`/api/admin/providers/${provider.id}/keys/${keyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        await fetchKeys();
        onUpdate();
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="w-5 h-5 text-primary" />
            {provider?.name} - API Keys
          </DialogTitle>
          <DialogDescription>
            {t("providers.apiKeys.description", "管理该供应商的 API 密钥。支持添加多个密钥，系统将自动进行轮询负载均衡。如果某个密钥配额耗尽，将自动被标记为“已停用”。")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mt-4">
          <Input 
            placeholder={t("providers.apiKeys.placeholder", "输入新的 API Key (sk-...)")} 
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddKey()}
          />
          <Button onClick={handleAddKey} disabled={adding || !newKey.trim()}>
            <Plus className="w-4 h-4 mr-1" /> {t("providers.actions.add", "添加")}
          </Button>
        </div>

        <div className="flex-1 overflow-auto mt-4 border rounded-md relative">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> {t("common.loading", "加载中...")}
            </div>
          ) : keys.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {t("providers.apiKeys.empty", "暂无配置密钥")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[45%]">{t("providers.apiKeys.table.apiKey", "API Key")}</TableHead>
                  <TableHead className="w-24">{t("providers.apiKeys.table.status", "状态")}</TableHead>
                  <TableHead className="w-[140px]">{t("providers.apiKeys.table.lastUsed", "最后使用")}</TableHead>
                  <TableHead className="text-right">{t("providers.apiKeys.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div className="font-mono text-[13px] bg-muted/50 px-2 py-1 rounded-md inline-block text-muted-foreground break-all">
                        {k.keyMasked}
                      </div>
                    </TableCell>
                    <TableCell>
                      {k.status === 'active' ? (
                        <Badge className="bg-green-100 text-green-800 border-green-200">{t("providers.apiKeys.status.active", "正常")}</Badge>
                      ) : (
                        <Badge variant="destructive">{t("providers.apiKeys.status.exhausted", "已停用 (耗尽)")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {k.lastUsedAt ? formatDateTime(new Date(k.lastUsedAt)) : t("providers.apiKeys.neverUsed", "从未使用")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleStatus(k.id, k.status)}
                          title={k.status === 'active' ? t("providers.apiKeys.actions.disable", '手动停用') : t("providers.apiKeys.actions.enable", '重新启用')}
                        >
                          {k.status === 'active' ? <XCircle className="w-4 h-4 text-orange-500" /> : <CheckCircle className="w-4 h-4 text-green-500" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(k.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
