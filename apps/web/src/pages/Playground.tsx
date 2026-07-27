import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Copy, Terminal, Server, Loader2, Code2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const API_KEY_PLACEHOLDER = "<YOUR_API_KEY>";

export default function Playground() {
  const { t } = useTranslation();
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedRouteId, setSelectedRouteId] = useState<string>("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [prompt, setPrompt] = useState(t("playground.hints.defaultPrompt", "请介绍自己"));
  
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const rData = await fetchApi("/user/routes");
      setRoutes(rData);

      if (rData.length > 0) setSelectedRouteId(rData[0].id);
    } catch (e: any) {
      toast.error(t("playground.toasts.loadFailed", "加载数据失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedRoute = routes.find(r => r.id === selectedRouteId);
  const exportApiKey = apiKeyInput.trim() || API_KEY_PLACEHOLDER;

  const getCurlCommand = () => {
    if (!selectedRoute) return t("playground.errors.selectRouteFirst", "请先选择路由");
    
    // Simulate subdomain by targeting the current host IP/Domain and overriding the Host header
    const protocol = window.location.protocol;
    const currentHost = window.location.host;
    const url = `${protocol}//${currentHost}${selectedRoute.path || ""}`;
      
    if (selectedRoute.incomingProtocol === "anthropic") {
      return `curl ${url} \\
  -H "Host: ${selectedRoute.host}" \\
  -H "x-api-key: ${exportApiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": ${JSON.stringify(prompt || t("playground.hints.defaultPrompt", "请介绍自己"))}}
    ]
  }'`;
    } else {
      return `curl ${url} \\
  -H "Host: ${selectedRoute.host}" \\
  -H "Authorization: Bearer ${exportApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": ${JSON.stringify(prompt || t("playground.hints.defaultPrompt", "请介绍自己"))}}
    ]
  }'`;
    }
  };

  const getClaudeCodeSettings = () => {
    if (!selectedRoute) return t("playground.errors.selectRouteFirst", "请先选择路由");
    
    const isAnthropic = selectedRoute.incomingProtocol === "anthropic";
    // For Claude Code integration, we MUST use the route's exact host, because Claude Code cannot simulate Host headers.
    const protocol = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http:" : "https:";
    
    let baseUrlPath = selectedRoute.path || '';
    if (isAnthropic) {
      baseUrlPath = baseUrlPath.replace('/v1/messages', '');
    } else {
      baseUrlPath = baseUrlPath.replace('/chat/completions', '');
    }
    const baseUrl = `${protocol}//${selectedRoute.host}${baseUrlPath}`;

    if (isAnthropic) {
      return `{
  "env": {
    "ANTHROPIC_API_KEY": ${JSON.stringify(exportApiKey)},
    "ANTHROPIC_BASE_URL": "${baseUrl}",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": []
  },
  "theme": "auto"
}`;
    } else {
      return `{
  "customProviders": {
    "promptgate": {
      "type": "openai",
      "baseUrl": "${baseUrl}",
      "apiKey": ${JSON.stringify(exportApiKey)}
    }
  }
}`;
    }
  };

  const getOpencodeSettings = () => {
    if (!selectedRoute) return t("playground.errors.selectRouteFirst", "请先选择路由");
    
    const protocol = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http:" : "https:";
    
    let baseUrlPath = selectedRoute.path || '';
    baseUrlPath = baseUrlPath
      .replace(/\/chat\/completions$/, '')
      .replace(/\/messages$/, '')
      .replace(/\/complete$/, '');
    
    const baseUrl = `${protocol}//${selectedRoute.host}${baseUrlPath}`;

    const config = {
      "$schema": "https://opencode.ai/config.json",
      "model": "promptgate/auto",
      "provider": {
        "promptgate": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "PromptGate",
          "options": {
            "baseURL": baseUrl,
            "apiKey": exportApiKey
          },
          "models": {
            "auto": {
              "name": "Auto Model",
              "attachment": true,
              "tool_call": true,
              "modalities": {
                "input": ["text", "image"],
                "output": ["text"]
              }
            }
          }
        }
      }
    };
    return JSON.stringify(config, null, 2);
  };

  const getHermesSettings = () => {
    if (!selectedRoute) return t("playground.errors.selectRouteFirst", "请先选择路由");
    
    const protocol = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http:" : "https:";
    
    let baseUrlPath = selectedRoute.path || '';
    baseUrlPath = baseUrlPath
      .replace(/\/chat\/completions$/, '')
      .replace(/\/messages$/, '')
      .replace(/\/complete$/, '');
    
    const baseUrl = `${protocol}//${selectedRoute.host}${baseUrlPath}`;

    return `model:
  provider: custom
  default: auto
  base_url: ${baseUrl}
  api_key: ${JSON.stringify(exportApiKey)}`;
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t("playground.toasts.copied", "已复制到剪贴板"));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col space-y-8 min-h-0">
      <div className="flex justify-end items-center">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" disabled={!selectedRoute}>
              <Code2 className="h-4 w-4 mr-2 text-blue-500" />
              {t("playground.actions.generateConfig", "生成配置")}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[800px] h-[650px] max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <Server className="h-5 w-5 text-blue-500" />
                {t("playground.dialog.title", "客户端集成配置")}
              </DialogTitle>
              <DialogDescription>
                {t("playground.dialog.description", "选择您使用的客户端工具，获取对应的集成配置。")}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md bg-blue-500/10 border border-blue-500/20 p-3 text-sm text-blue-600 dark:text-blue-400 shrink-0 mt-2">
              {t("playground.dialog.virtualModelHint", "auto 是 PromptGate 的虚拟模型。客户端始终请求 auto，真实供应商和模型由 PromptGate 根据当前域名、API Key 与统一路由动态选择。Opencode 需要显式声明 auto 支持图片输入，否则可能不会发送图片附件。")}
            </div>
            
            <Tabs defaultValue="claude" className="flex-1 overflow-hidden flex flex-col min-h-0 mt-2">
              <TabsList className="grid w-full grid-cols-3 shrink-0">
                <TabsTrigger value="claude">Claude Code / Cursor</TabsTrigger>
                <TabsTrigger value="opencode">Opencode</TabsTrigger>
                <TabsTrigger value="hermes">Hermes</TabsTrigger>
              </TabsList>
              
              <TabsContent value="claude" className="flex-1 overflow-hidden flex flex-col min-h-0 mt-4 space-y-4">
                <div className="text-sm text-muted-foreground shrink-0">
                  {t("playground.dialog.claudeDesc", "将以下配置添加到您的 ~/.claude/settings.json 或 Cursor 的自定义模型配置中。")}
                </div>
                <div className="flex-1 rounded-md bg-muted border overflow-hidden flex flex-col min-h-0">
                  <div className="bg-muted/50 border-b px-4 py-2 flex items-center justify-between shrink-0">
                    <div className="text-xs text-muted-foreground font-mono">settings.json</div>
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleCopy(getClaudeCodeSettings())}>
                      <Copy className="h-3 w-3 mr-1" />
                      {t("playground.dialog.copy", "复制")}
                    </Button>
                  </div>
                  <pre className="p-4 text-sm font-mono text-foreground overflow-auto flex-1">
                    <code>{getClaudeCodeSettings()}</code>
                  </pre>
                </div>
              </TabsContent>
              
              <TabsContent value="opencode" className="flex-1 overflow-hidden flex flex-col min-h-0 mt-4 space-y-4">
                <div className="text-sm text-muted-foreground shrink-0">
                  {t("playground.dialog.opencodeDesc", "将以下配置保存为 ~/.config/opencode/opencode.json。详见")}
                  <a href="https://opencode.ai/docs/zh-cn/config/" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline ml-1">
                    {t("playground.dialog.opencodeDocs", "官方文档")}
                  </a>
                </div>
                <div className="flex-1 rounded-md bg-muted border overflow-hidden flex flex-col min-h-0">
                  <div className="bg-muted/50 border-b px-4 py-2 flex items-center justify-between shrink-0">
                    <div className="text-xs text-muted-foreground font-mono">opencode.json</div>
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleCopy(getOpencodeSettings())}>
                      <Copy className="h-3 w-3 mr-1" />
                      {t("playground.dialog.copy", "复制")}
                    </Button>
                  </div>
                  <pre className="p-4 text-sm font-mono text-foreground overflow-auto flex-1">
                    <code>{getOpencodeSettings()}</code>
                  </pre>
                </div>
              </TabsContent>
              
              <TabsContent value="hermes" className="flex-1 overflow-hidden flex flex-col min-h-0 mt-4 space-y-4">
                <div className="text-sm text-muted-foreground shrink-0">
                  {t("playground.dialog.hermesDesc", "将以下配置保存为 /tmp/hermes-config.yaml。详见")}
                  <a href="https://hermes-agent.nousresearch.com/" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline ml-1">
                    {t("playground.dialog.hermesDocs", "Hermes 文档")}
                  </a>
                </div>
                <div className="flex-1 rounded-md bg-muted border overflow-hidden flex flex-col min-h-0">
                  <div className="bg-muted/50 border-b px-4 py-2 flex items-center justify-between shrink-0">
                    <div className="text-xs text-muted-foreground font-mono">config.yaml</div>
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleCopy(getHermesSettings())}>
                      <Copy className="h-3 w-3 mr-1" />
                      {t("playground.dialog.copy", "复制")}
                    </Button>
                  </div>
                  <pre className="p-4 text-sm font-mono text-foreground overflow-auto flex-1 whitespace-pre-wrap word-break-all">
                    <code>{getHermesSettings()}</code>
                  </pre>
                </div>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-1 min-h-0">
        
        {/* Left Column: Input Form */}
        <div className="space-y-6 flex flex-col min-h-0 h-full">
          <Card className="shadow-lg border-muted flex flex-col min-h-0 h-full">
            <CardContent className="p-6 space-y-6 flex-1 overflow-y-auto">
              
              <div className="space-y-3">
                <Label className="font-medium text-base">{t("playground.fields.selectRoute", "选择路由")}</Label>
                <Select value={selectedRouteId} onValueChange={setSelectedRouteId}>
                  <SelectTrigger className="h-12 bg-background">
                    <SelectValue placeholder={t("playground.placeholders.noRoute", "无可用路由")} />
                  </SelectTrigger>
                  <SelectContent>
                    {routes.map(r => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedRoute && selectedRoute.host && selectedRoute.path && (
                  <div className="mt-3 flex items-center gap-3">
                    <Badge variant="secondary" className="bg-blue-500/10 text-blue-500 border border-blue-500/20 px-2.5 py-1">
                      {selectedRoute.incomingProtocol.toUpperCase()}
                    </Badge>
                    <div className="text-sm text-muted-foreground font-mono">
                      {selectedRoute.host}{selectedRoute.path}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <Label className="font-medium text-base">{t("playground.fields.apiKey", "API Key")}</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  className="h-12 bg-background text-base"
                  placeholder={t("playground.placeholders.apiKey", "粘贴完整 API Key，将自动嵌入右侧代码")}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("playground.hints.apiKey", "仅用于当前页面生成代码，不会保存；留空时使用 <YOUR_API_KEY> 占位符。")}
                </p>
              </div>

              <div className="space-y-3">
                <Label className="font-medium text-base">{t("playground.fields.prompt", "提示词")}</Label>
                <Textarea 
                  className="min-h-[200px] resize-none focus:ring-blue-500/50 bg-background text-base p-4"
                  placeholder={t("playground.placeholders.prompt", "输入您想测试的对话内容...")}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                />
              </div>

            </CardContent>
          </Card>
        </div>

        {/* Right Column: Code Generation */}
        <div className="space-y-6 flex flex-col min-h-0 h-full">
          <Card className="shadow-lg border-muted overflow-hidden h-full flex flex-col min-h-0">
            <div className="bg-muted border-b px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Terminal className="h-5 w-5 text-blue-500" />
                {t("playground.cUrlTest", "cURL 快速测试")}
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => handleCopy(getCurlCommand())}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t("playground.actions.copyCode", "复制代码")}
              </Button>
            </div>
            <CardContent className="p-0 flex-1 bg-zinc-950 min-h-0 overflow-y-auto">
              <div className="p-6 min-h-full">
                <p className="text-sm text-zinc-400 mb-4 font-medium flex items-center">
                  <span className="w-2 h-2 rounded-full bg-blue-500 mr-2"></span>
                  {t("playground.hints.codeTips", "提示：左侧输入完整 API Key 后会自动嵌入代码；留空时显示 <YOUR_API_KEY> 占位符。")}
                </p>
                <pre className="text-sm font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                  <code className="block">{getCurlCommand()}</code>
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}
