const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const chat = document.getElementById("chat");

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addLoading() {
  const div = document.createElement("div");
  div.className = "msg assistant loading";
  div.innerHTML = 'Checking the latest match data<span class="dots"></span>';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) return;

  addMessage(question, "user");
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;

  const loading = addLoading();

  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    const data = await res.json();
    loading.remove();

    if (!res.ok) {
      addMessage(data.error || "Something went wrong. Please try again.", "error");
    } else {
      addMessage(data.reply, "assistant");
    }
  } catch {
    loading.remove();
    addMessage("Couldn't reach the server. Please check your connection and try again.", "error");
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
});
