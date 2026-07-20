using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("入团申请材料审核助手")]
[assembly: AssemblyDescription("入团申请材料审核助手离线启动器")]
[assembly: AssemblyCompany("jzcangshu")]
[assembly: AssemblyProduct("入团申请材料审核助手")]
[assembly: AssemblyCopyright("Copyright © jzcangshu")]

internal static class LeagueReviewHelperLauncher
{
    private static readonly object LogLock = new object();

    [STAThread]
    private static int Main()
    {
        string appRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        string mutexName = "Local\\LeagueReviewHelper-" + StableId(appRoot);
        bool created;
        using (var mutex = new Mutex(true, mutexName, out created))
        {
            if (!created)
            {
                int existingPort = WaitForHealthyPort(appRoot, TimeSpan.FromSeconds(12));
                if (existingPort > 0) OpenBrowser(existingPort);
                return existingPort > 0 ? 0 : 2;
            }

            int healthyPort = GetHealthyPort(appRoot);
            if (healthyPort > 0)
            {
                OpenBrowser(healthyPort);
                return 0;
            }

            return StartServer(appRoot);
        }
    }

    private static int StartServer(string appRoot)
    {
        string nodeExe = Path.Combine(appRoot, "runtime", "node", "node.exe");
        string pythonExe = Path.Combine(appRoot, "runtime", "python", "python.exe");
        string serverDir = Path.Combine(appRoot, "review-web");
        string serverScript = Path.Combine(serverDir, "server.js");
        string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LeagueReviewHelper", "logs");
        Directory.CreateDirectory(logDir);
        string logPath = Path.Combine(logDir, "launcher.log");

        foreach (string required in new[] { nodeExe, pythonExe, serverScript })
        {
            if (!File.Exists(required))
            {
                MessageBox.Show("安装文件不完整，请重新安装。\r\n\r\n缺少：" + required,
                    "入团申请材料审核助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }
        }

        var started = new ManualResetEventSlim(false);
        int detectedPort = 0;
        var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + serverScript + "\"",
            WorkingDirectory = serverDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        process.StartInfo.EnvironmentVariables["REVIEW_OCR_RUNTIME_PYTHON"] = pythonExe;
        process.StartInfo.EnvironmentVariables["PYTHONUTF8"] = "1";

        using (var log = new StreamWriter(logPath, true, new UTF8Encoding(false)))
        {
            log.AutoFlush = true;
            DataReceivedEventHandler capture = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null) return;
                lock (LogLock) log.WriteLine(DateTime.Now.ToString("s") + " " + args.Data);
                Match match = Regex.Match(args.Data, @"http://127\.0\.0\.1:(\d+)");
                int port;
                if (match.Success && int.TryParse(match.Groups[1].Value, out port))
                {
                    detectedPort = port;
                    started.Set();
                }
            };
            process.OutputDataReceived += capture;
            process.ErrorDataReceived += capture;

            try
            {
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception error)
            {
                log.WriteLine(error);
                MessageBox.Show("启动失败，请重新安装或反馈日志：\r\n" + logPath,
                    "入团申请材料审核助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 4;
            }

            if (!started.Wait(TimeSpan.FromSeconds(30)))
            {
                detectedPort = GetHealthyPort(appRoot);
            }
            if (detectedPort <= 0 || !HealthMatches(detectedPort, appRoot))
            {
                MessageBox.Show("服务启动超时。请重新启动；若仍失败，请反馈日志：\r\n" + logPath,
                    "入团申请材料审核助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 5;
            }

            OpenBrowser(detectedPort);
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static int WaitForHealthyPort(string appRoot, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        int port;
        while (DateTime.UtcNow < deadline)
        {
            port = GetHealthyPort(appRoot);
            if (port > 0) return port;
            Thread.Sleep(250);
        }
        return 0;
    }

    private static int GetHealthyPort(string appRoot)
    {
        string portFile = Path.Combine(Path.GetTempPath(), "review-web-port.json");
        if (!File.Exists(portFile)) return 0;
        try
        {
            Match match = Regex.Match(File.ReadAllText(portFile), "\\\"port\\\"\\s*:\\s*(\\d+)");
            int port;
            return match.Success && int.TryParse(match.Groups[1].Value, out port) && HealthMatches(port, appRoot) ? port : 0;
        }
        catch { return 0; }
    }

    private static bool HealthMatches(int port, string appRoot)
    {
        try
        {
            var request = WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            request.Timeout = 1500;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                var payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                object ok;
                object workspace;
                if (!payload.TryGetValue("ok", out ok) || !Convert.ToBoolean(ok)) return false;
                if (!payload.TryGetValue("workspaceRoot", out workspace)) return false;
                return string.Equals(Path.GetFullPath(Convert.ToString(workspace)).TrimEnd('\\'),
                    Path.GetFullPath(appRoot).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            }
        }
        catch { return false; }
    }

    private static void OpenBrowser(int port)
    {
        if (string.Equals(Environment.GetEnvironmentVariable("LEAGUE_REVIEW_NO_BROWSER"), "1", StringComparison.Ordinal)) return;
        Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port) { UseShellExecute = true });
    }

    private static string StableId(string value)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
            return BitConverter.ToString(hash, 0, 8).Replace("-", string.Empty);
        }
    }
}
