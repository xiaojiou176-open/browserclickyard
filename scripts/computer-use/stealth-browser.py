"""
Stealth browser automation using browser-use-undetected.
This uses Camoufox (anti-detection Firefox) + AI to automate tasks.
Gemini-only setup: requires GEMINI_API_KEY.
"""

from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()


async def main():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY is required")
        return

    # Try to import browser-use-undetected
    try:
        from browser_use_undetected import Agent
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        print("Please install: pip install browser-use-undetected langchain-google-genai")
        print("\nThen run: playwright install")
        return

    # Initialize Gemini LLM
    llm = ChatGoogleGenerativeAI(
        model=os.getenv("GEMINI_MODEL", "models/gemini-3.1-pro-preview"),
        temperature=0.0,
        google_api_key=api_key,
    )

    # Create agent with stealth browser
    agent = Agent(
        task="""
        Go to https://example.com and confirm the page is reachable.
        Summarize the main heading shown on the page.
        """,
        llm=llm,
    )

    # Run the agent
    result = await agent.run()
    print(f"Result: {result}")


if __name__ == "__main__":
    main()
