针对于目前文件夹，我打算做一个项目，以下是项目的大致框架
1.写一个主agent，用于协调其他agent的工作。
主agent负责任务的创建与调度，也就是当用户输入内容之后，
1.主agent会对任务进行分析，
2.然后创建一个todoList
3.将任务分发给子agent
每个子agent负责执行一个任务。然后都是新的进程，互不干扰。这样去实现隔离
2.写其他agent，用于执行具体任务。
例如：
1. 一个agent用于编写代码。
2. 一个agent用于执行代码。
3. 一个agent用于报告执行结果。
4.当子agent完成之后会返回给主agent一个finish消息
5.主agent会根据finish消息来判断是否需要继续执行其他任务。
现在目前就生成一个具备write_code、review_code的功能的一个agent吧

