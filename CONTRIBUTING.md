# Contributing to Summon

🎉 **Thank you for your interest in contributing to Summon!**

Summon is an open-source project that thrives on community contributions. Whether you're fixing bugs, adding features, improving documentation, or sharing ideas, your contributions make Summon better for everyone.

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18 or higher)
- **npm** or **yarn**
- **Git**

### Setting Up Your Development Environment

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/summon-app.git
   cd summon-app
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Start the development server**:
   ```bash
   npm start
   ```

## 🛠️ Development Workflow

### Making Changes

1. **Create a new branch** for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. **Make your changes** following our coding standards
3. **Test your changes** thoroughly
4. **Commit your changes** with a clear message:
   ```bash
   git commit -m "feat: add amazing new feature"
   ```
5. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
6. **Create a Pull Request** on GitHub

### Commit Message Guidelines

We follow conventional commit format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## 🧪 Testing

Before submitting your PR, make sure to:

- [ ] Run the test suite: `npm test`
- [ ] Test the Electron app: `npm start`
- [ ] Verify MCP server generation works correctly
- [ ] Test the AI playground with your changes

## 📝 Code Style

- **TypeScript** - We use TypeScript for type safety
- **ESLint & Prettier** - Code formatting is enforced
- **React** - Follow React best practices and hooks patterns
- **Electron** - Follow Electron security best practices

Run the linter before committing:

```bash
npm run lint
npm run format
```

## 🐛 Reporting Issues

Found a bug? We'd love to hear about it!

1. **Check existing issues** first to avoid duplicates
2. **Use our issue templates** when creating new issues
3. **Provide detailed information**:
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots/videos if applicable
   - System information (OS, Node version, etc.)

## 💡 Feature Requests

Have an idea for Summon? Great!

1. **Check the roadmap** and existing feature requests
2. **Open a discussion** to get community feedback
3. **Create a detailed feature request** with:
   - Clear description of the feature
   - Use cases and benefits
   - Potential implementation approach

## 🏗️ Project Structure

```
summon-app/
├── src/
│   ├── components/     # React components
│   ├── helpers/        # Utility functions
│   ├── stores/         # State management
│   ├── types/          # TypeScript definitions
│   └── main.ts         # Electron main process
├── public/             # Static assets
├── docs/               # Documentation
└── tests/              # Test files
```

## 🤝 Community Guidelines

- **Be respectful** and inclusive
- **Help others** learn and grow
- **Give constructive feedback** in code reviews
- **Ask questions** if you're unsure about anything
- **Share your knowledge** through discussions and documentation

## 📚 Resources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Electron Documentation](https://www.electronjs.org/docs)
- [React Documentation](https://react.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## 🎯 Areas We Need Help With

- 🐛 **Bug fixes** - Help us squash those pesky bugs
- 📖 **Documentation** - Improve guides and API docs
- 🧪 **Testing** - Add more test coverage
- 🎨 **UI/UX** - Make Summon even more beautiful and intuitive
- 🔌 **MCP Integrations** - Add support for more MCP servers
- 🤖 **AI Model Support** - Expand AI provider integrations

## 📞 Getting Help

Need help contributing? Reach out!

- 💬 **GitHub Discussions** - Ask questions and share ideas
- 🐛 **GitHub Issues** - Report bugs and request features
- 📧 **Email** - Contact the maintainers directly

---

**Ready to contribute?** We can't wait to see what you'll build! 🚀

_Every contribution, no matter how small, makes Summon better for the entire community._
